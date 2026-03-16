// src/oracle.js — Gemini версія з Google Search
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios  = require('axios');
const db     = require('./db');
const logger = require('./logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const FEE   = 0.02;

// Модель для верифікації — з вбудованим Google Search
const verifyModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-pro',
  tools: [{ googleSearch: {} }], // ← ключова фіча: реальний пошук!
});

// Дешевша модель для модерації гравців
const moderateModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
});

// ── 1. CoinGecko (крипто) ────────────────
async function verifyCrypto(market) {
  try {
    const coinMap = {
      bitcoin: 'bitcoin', btc: 'bitcoin',
      ethereum: 'ethereum', eth: 'ethereum',
      solana: 'solana', sol: 'solana',
      bnb: 'binancecoin',
    };
    const q      = market.question.toLowerCase();
    const coinId = Object.entries(coinMap).find(([k]) => q.includes(k))?.[1];
    if (!coinId) return null;

    const priceMatch = market.question.match(/\$[\d,]+/);
    if (!priceMatch) return null;
    const target = parseFloat(priceMatch[0].replace(/[$,]/g, ''));

    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: coinId, vs_currencies: 'usd' }, timeout: 8000,
    });
    const current = res.data[coinId]?.usd;
    if (!current) return null;

    let result = null;
    if (q.match(/перевищить|перетре|досягне|above|exceed|вище/))
      result = current > target ? 'yes' : 'no';
    else if (q.match(/нижче|below|впаде/))
      result = current < target ? 'yes' : 'no';
    if (!result) return null;

    return {
      result, confidence: 98, method: 'api_crypto',
      explanation: `${coinId}: $${current.toLocaleString()} | ціль $${target.toLocaleString()} → ${result.toUpperCase()}`,
    };
  } catch (err) {
    logger.warn('CoinGecko error:', err.message);
    return null;
  }
}

// ── 2. ExchangeRate (форекс) ─────────────
async function verifyForex(market) {
  try {
    const pairMatch  = market.question.match(/([A-Z]{3})\/([A-Z]{3})/);
    if (!pairMatch) return null;
    const [, base, quote] = pairMatch;
    const targetMatch = market.question.match(/[\d.]+/);
    if (!targetMatch) return null;
    const target = parseFloat(targetMatch[0]);

    const res = await axios.get(`https://api.exchangerate-api.com/v4/latest/${base}`, { timeout: 8000 });
    const current = res.data.rates?.[quote];
    if (!current) return null;

    const q = market.question.toLowerCase();
    let result = null;
    if (q.match(/вище|above|перевищить/)) result = current > target ? 'yes' : 'no';
    else if (q.match(/нижче|below|впаде/)) result = current < target ? 'yes' : 'no';
    if (!result) return null;

    return {
      result, confidence: 96, method: 'api_forex',
      explanation: `${base}/${quote}: ${current} | ціль ${target} → ${result.toUpperCase()}`,
    };
  } catch (err) {
    logger.warn('Forex error:', err.message);
    return null;
  }
}

// ── 3. Gemini + Google Search (головний) ──
async function verifyWithGemini(market) {
  try {
    const deadline = new Date(market.deadline).toLocaleDateString('uk-UA');
    const today    = new Date().toLocaleDateString('uk-UA');

    const prompt = `
Ти — верифікатор prediction market. Використай Google Search для пошуку актуальної інформації.

Питання: "${market.question}"
Деталі: "${market.sub}"
Дедлайн: ${deadline}
Сьогодні: ${today}
Джерело: ${market.source || 'не вказано'}

Знайди актуальну інформацію і визнач результат.

Відповідай ТІЛЬКИ валідним JSON без тексту навколо:
{"result":"yes","confidence":95,"explanation":"пояснення","source_used":"URL або назва джерела"}

Правила:
- result: "yes" | "no" | "unclear"
- confidence < 70 → встанови "unclear"
- Дедлайн не настав → "unclear"
- Будь максимально об'єктивним
`.trim();

    const result = await verifyModel.generateContent(prompt);
    const raw    = result.response.text().trim();
    const match  = raw.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('Невалідний JSON');

    const parsed = JSON.parse(match[0]);
    return {
      result:      parsed.result,
      confidence:  parsed.confidence || 0,
      explanation: parsed.explanation,
      source:      parsed.source_used,
      method:      'gemini_search',
    };
  } catch (err) {
    logger.error('Gemini verify error:', err.message);
    return { result: 'unclear', confidence: 0, explanation: 'Помилка AI', method: 'error' };
  }
}

// ── 4. Модерація ринків гравців ──────────
async function moderateUserMarket(market) {
  try {
    const prompt = `Ти — модератор prediction market.

Гравець створює ринок:
Питання: "${market.question}"
Деталі: "${market.sub || ''}"

Перевір:
✅ Дозволено: чітка YES/NO відповідь, публічно перевіряється, актуальне
❌ Заборонено: образи, приватні особи, неперевірювані питання, спам

Відповідай ТІЛЬКИ JSON:
{"approved":true,"reason":"пояснення","suggestion":"порада якщо відхилено"}`;

    const result = await moderateModel.generateContent(prompt);
    const raw    = result.response.text().trim();
    const match  = raw.match(/\{[\s\S]*?\}/);
    if (!match) return { approved: true, reason: 'Авто-схвалення' };
    return JSON.parse(match[0]);
  } catch {
    return { approved: true, reason: 'AI недоступний, авто-схвалення' };
  }
}

// ── 5. Виплата переможцям ────────────────
function payoutWinners(market, result) {
  const bets = db.getBetsForMarket(market.id);

  if (market.poolYes === 0 || market.poolNo === 0) {
    logger.info(`↩ Ринок #${market.id}: повернення`);
    bets.forEach(b => db.addGems(b.userId, b.amount));
    db.updateMarket(market.id, { status: 'resolved', result: 'refund', resolvedAt: new Date().toISOString() });
    return { type: 'refund', total: 0, winners: 0 };
  }

  const totalPool   = market.poolYes + market.poolNo;
  const netPool     = totalPool * (1 - FEE);
  const winPool     = result === 'yes' ? market.poolYes : market.poolNo;
  const winningBets = bets.filter(b => b.side === result);
  let totalPayout   = 0;

  winningBets.forEach(bet => {
    const payout = Math.floor((bet.amount / winPool) * netPool);
    db.addGems(bet.userId, payout);
    totalPayout += payout;
    logger.info(`💰 Гравець #${bet.userId}: +${payout} 💎`);
  });

  db.updateMarket(market.id, { status: 'resolved', result, resolvedAt: new Date().toISOString() });

  return { type: 'payout', total: totalPayout, winners: winningBets.length, losers: bets.length - winningBets.length };
}

// ── 6. ГОЛОВНА: перевірка закінчених ─────
async function checkExpiredMarkets() {
  const expired = db.getExpiredMarkets();
  if (!expired.length) return [];

  logger.info(`🔍 Перевіряю ${expired.length} ринків...`);
  const resolved = [];

  for (const market of expired) {
    logger.info(`⏳ #${market.id}: ${market.question}`);
    db.updateMarket(market.id, { status: 'checking' });

    try {
      // Вибираємо найточніший верифікатор
      let v = null;
      if (market.room === 'crypto')                         v = await verifyCrypto(market);
      if (!v && ['global','eu'].includes(market.room))      v = await verifyForex(market);
      if (!v)                                               v = await verifyWithGemini(market);

      logger.info(`📊 #${market.id}: ${v.result} (${v.confidence}%) — ${v.explanation?.slice(0, 80)}`);

      if (v.result !== 'unclear' && v.confidence >= 75) {
        const payout = payoutWinners(market, v.result);
        db.updateMarket(market.id, { resolveNote: `${v.explanation} [${v.method}]` });
        resolved.push({ market, verification: v, payout });
        logger.info(`✅ Вирішено #${market.id}: ${v.result} | виплачено ${payout.total} 💎`);
      } else {
        db.updateMarket(market.id, {
          status: 'pending_review',
          resolveNote: `Gemini невпевнений (${v.confidence}%): ${v.explanation}`,
        });
        logger.warn(`⚠️ #${market.id} → ручна перевірка`);
      }
    } catch (err) {
      db.updateMarket(market.id, { status: 'open' });
      logger.error(`❌ Помилка #${market.id}:`, err.message);
    }
  }

  return resolved;
}

module.exports = { checkExpiredMarkets, moderateUserMarket, verifyCrypto, verifyForex, verifyWithGemini };
