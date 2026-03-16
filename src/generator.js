// src/generator.js — Gemini версія
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios  = require('axios');
const db     = require('./db');
const logger = require('./logger');

const genAI   = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const ROOMS = {
  crypto:  { icon: '₿',   tp: 'flash' },
  ua:      { icon: '🇺🇦', tp: 'hot'   },
  global:  { icon: '🌍',  tp: 'new'   },
  us:      { icon: '🏛️', tp: 'hot'   },
  eu:      { icon: '💶',  tp: 'new'   },
  sports:  { icon: '⚽',  tp: 'new'   },
  tech:    { icon: '🤖',  tp: 'mega'  },
};

function deadlineISO(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}
function deadlineLabel(h) {
  if (h <= 1) return '1г 00:00';
  if (h <= 6) return '6г 00:00';
  if (h <= 24) return '24г 00:00';
  if (h <= 72) return '3д 00:00';
  if (h <= 168) return '7д 00:00';
  return '30д 00:00';
}

async function fetchNews() {
  try {
    const [ua, world] = await Promise.all([
      axios.get('https://newsapi.org/v2/top-headlines', {
        params: { country: 'ua', pageSize: 10, apiKey: process.env.NEWS_API_KEY },
        timeout: 8000,
      }).catch(() => ({ data: { articles: [] } })),
      axios.get('https://newsapi.org/v2/top-headlines', {
        params: { language: 'en', pageSize: 15, category: 'business', apiKey: process.env.NEWS_API_KEY },
        timeout: 8000,
      }).catch(() => ({ data: { articles: [] } })),
    ]);
    return {
      ua:    (ua.data.articles    || []).map(a => `- ${a.title}`).join('\n') || '- немає',
      world: (world.data.articles || []).map(a => `- ${a.title}`).join('\n') || '- немає',
    };
  } catch { return { ua: '- немає', world: '- немає' }; }
}

async function fetchCryptoPrices() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'bitcoin,ethereum,solana,binancecoin', vs_currencies: 'usd' },
      timeout: 6000,
    });
    const p = res.data;
    return `BTC $${p.bitcoin?.usd?.toLocaleString()} | ETH $${p.ethereum?.usd?.toLocaleString()} | SOL $${p.solana?.usd?.toLocaleString()}`;
  } catch { return 'ціни недоступні'; }
}

async function generateWithGemini(news, cryptoPrices) {
  const today = new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `Ти — менеджер prediction market OracleX.
Сьогодні: ${today}. Крипто: ${cryptoPrices}

Українські новини:
${news.ua}

Світові новини:
${news.world}

Створи рівно 12 питань: 3 крипто, 3 UA, 2 світові, 2 спорт, 1 tech, 1 економіка.

Вимоги: відповідь YES/NO, результат відомий за 1-7 днів, є публічне джерело.

Відповідай ТІЛЬКИ валідним JSON без жодного тексту навколо:
[{"question":"...","sub":"...","room":"crypto","icon":"₿","deadline_hours":168,"source":"https://...","confidence":90}]`;

  const result = await genModel.generateContent(prompt);
  const raw    = result.response.text().trim();
  const match  = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Невалідний JSON від Gemini: ' + raw.slice(0, 100));
  return JSON.parse(match[0]);
}

function saveMarkets(markets) {
  const created = [];
  for (const m of markets) {
    if ((m.confidence || 100) < 50) continue;
    const room = ROOMS[m.room] || ROOMS.global;
    const market = db.createMarket({
      question: m.question, sub: m.sub || '',
      room: m.room || 'global', icon: m.icon || room.icon,
      deadline: deadlineISO(m.deadline_hours || 24),
      deadlineStr: deadlineLabel(m.deadline_hours || 24),
      source: m.source || '', tp: room.tp, createdBy: 'bot',
    });
    created.push(market);
    logger.info(`✅ #${market.id} [${m.room}] ${market.question}`);
  }
  return created;
}

async function generateDailyMarkets() {
  logger.info('🤖 Генерую ринки через Gemini...');
  try {
    const [news, crypto] = await Promise.all([fetchNews(), fetchCryptoPrices()]);
    logger.info(`💰 ${crypto}`);
    const aiMarkets = await generateWithGemini(news, crypto);
    logger.info(`🧠 Gemini: ${aiMarkets.length} питань`);
    const created = saveMarkets(aiMarkets);
    logger.info(`💾 Збережено: ${created.length}`);
    return created;
  } catch (err) {
    logger.error('❌ Помилка генерації:', err.message);
    return saveMarkets([
      { question: 'Bitcoin перетне $100,000 сьогодні?', sub: 'CoinGecko', room: 'crypto', icon: '₿', deadline_hours: 24, source: 'https://coingecko.com/en/coins/bitcoin', confidence: 100 },
      { question: 'EUR/USD вище 1.05 до кінця тижня?', sub: 'Investing.com', room: 'global', icon: '💶', deadline_hours: 168, source: 'https://investing.com/currencies/eur-usd', confidence: 100 },
      { question: 'S&P 500 у плюсі сьогодні?', sub: 'Yahoo Finance', room: 'us', icon: '📈', deadline_hours: 24, source: 'https://finance.yahoo.com/quote/%5EGSPC/', confidence: 100 },
    ]);
  }
}

module.exports = { generateDailyMarkets };
