// src/btc-live.js
// ════════════════════════════════════════
//  BTC РЕАЛТАЙМ WEBSOCKET СЕРВЕР
//
//  1. Підключається до Binance WebSocket
//  2. Отримує ціни в реальному часі (~100ms)
//  3. Транслює до клієнтів Mini App
//  4. Кожні 5 хвилин створює новий ринок
// ════════════════════════════════════════

const WebSocket = require('ws');
const db        = require('./db');
const logger    = require('./logger');

// ── Стан ─────────────────────────────────
let currentBTC    = null;   // поточна ціна
let targetPrice   = null;   // ціна на початку раунду
let roundStart    = null;   // початок раунду (ms)
let roundEnd      = null;   // кінець раунду (ms)
let currentMarket = null;   // поточний активний ринок
let priceHistory  = [];     // масив {price, ts} за поточний раунд
let clients       = new Set(); // підключені Mini App клієнти

const ROUND_MS    = 5 * 60 * 1000; // 5 хвилин
const WS_PORT     = parseInt(process.env.WS_PORT) || 3001;

// ── Binance WebSocket ─────────────────────
let binanceWS = null;

function connectToBinance() {
  logger.info('🔗 Підключення до Binance WebSocket...');

  binanceWS = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');

  binanceWS.on('open', () => {
    logger.info('✅ Binance WebSocket підключено');
  });

  binanceWS.on('message', (raw) => {
    try {
      const data  = JSON.parse(raw);
      const price = parseFloat(data.p);
      const ts    = data.T; // timestamp угоди

      if (!price || isNaN(price)) return;

      currentBTC = price;

      // Зберігаємо в історію поточного раунду
      priceHistory.push({ price, ts });
      // Тримаємо тільки останні 300 точок (5 хвилин при 1 точці/сек)
      if (priceHistory.length > 300) priceHistory.shift();

      // Транслюємо до всіх клієнтів
      broadcastPrice(price, ts);

    } catch (err) {
      logger.warn('Binance WS parse error:', err.message);
    }
  });

  binanceWS.on('close', () => {
    logger.warn('⚠️ Binance WS закрито — перепідключення через 3с');
    setTimeout(connectToBinance, 3000);
  });

  binanceWS.on('error', (err) => {
    logger.error('Binance WS error:', err.message);
  });
}

// ── Трансляція до клієнтів ─────────────────
function broadcastPrice(price, ts) {
  if (clients.size === 0) return;

  const now      = Date.now();
  const timeLeft = roundEnd ? Math.max(0, roundEnd - now) : ROUND_MS;
  const change   = targetPrice ? ((price - targetPrice) / targetPrice * 100) : 0;

  const msg = JSON.stringify({
    type:         'price',
    price,
    ts,
    targetPrice,
    change:       +change.toFixed(4),
    timeLeft,     // ms до кінця раунду
    roundStart,
    roundEnd,
    marketId:     currentMarket?.id || null,
    priceHistory: priceHistory.slice(-60), // останні 60 точок для графіку
  });

  // Відправляємо всім підключеним клієнтам
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastRoundResult(result) {
  const msg = JSON.stringify({
    type:        'round_end',
    result,      // 'up' | 'down'
    finalPrice:  currentBTC,
    targetPrice,
    marketId:    currentMarket?.id,
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastNewRound(market) {
  const msg = JSON.stringify({
    type:        'new_round',
    marketId:    market.id,
    question:    market.question,
    targetPrice: currentBTC,
    roundEnd:    Date.now() + ROUND_MS,
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── Управління раундами ────────────────────
async function startNewRound() {
  if (!currentBTC) {
    logger.warn('⚠️ Немає ціни BTC — пропускаємо раунд');
    setTimeout(startNewRound, 5000);
    return;
  }

  targetPrice  = currentBTC;
  roundStart   = Date.now();
  roundEnd     = roundStart + ROUND_MS;
  priceHistory = [{ price: currentBTC, ts: roundStart }];

  // Форматуємо ціну для питання
  const priceFormatted = targetPrice.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const endTime = new Date(roundEnd);
  const timeStr = endTime.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit',
  });

  // Створюємо ринок в БД
  const deadline = new Date(roundEnd).toISOString();
  const market   = db.createMarket({
    question:    `BTC вище $${priceFormatted} о ${timeStr}?`,
    sub:         `Bitcoin закриє 5-хвилинний раунд вище стартової позначки $${priceFormatted}?`,
    room:        'crypto',
    icon:        '₿',
    tp:          'flash',
    deadline,
    deadlineStr: '5хв',
    source:      'binance',
    targetPrice, // ← зберігаємо target для оракула
    isLive:      true,
  });

  currentMarket = market;

  logger.info(`🆕 BTC раунд #${market.id}: target $${priceFormatted} → закриття о ${timeStr}`);

  // Сповіщаємо клієнтів
  broadcastNewRound(market);

  // Плануємо завершення раунду
  setTimeout(endRound, ROUND_MS);
}

async function endRound() {
  if (!currentMarket || !targetPrice || !currentBTC) return;

  const result  = currentBTC > targetPrice ? 'yes' : 'no';
  const resultLabel = currentBTC > targetPrice ? 'UP ↑' : 'DOWN ↓';

  logger.info(`🏁 BTC раунд #${currentMarket.id} завершено: ${resultLabel}`);
  logger.info(`   Target: $${targetPrice.toFixed(2)} | Final: $${currentBTC.toFixed(2)}`);

  // Виплачуємо переможців
  const { payoutWinners } = require('./oracle');
  const payout = payoutWinners(currentMarket, result);

  db.updateMarket(currentMarket.id, {
    status:      'resolved',
    result,
    resolvedAt:  new Date().toISOString(),
    resolveNote: `Binance реалтайм: старт $${targetPrice.toFixed(2)} → фінал $${currentBTC.toFixed(2)} [${resultLabel}]`,
    finalPrice:  currentBTC,
  });

  logger.info(`💰 Виплачено: ${payout.total} 💎 (${payout.winners} переможців)`);

  // Сповіщаємо клієнтів про результат
  broadcastRoundResult(result);

  // Починаємо новий раунд через 3 секунди
  setTimeout(startNewRound, 3000);
}

// ── WebSocket сервер для Mini App ──────────
function startWSServer() {
  const wss = new WebSocket.Server({ port: WS_PORT });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    logger.info(`👤 Клієнт підключився (всього: ${clients.size})`);

    // Відразу відправляємо поточний стан
    if (currentBTC) {
      ws.send(JSON.stringify({
        type:         'init',
        price:        currentBTC,
        targetPrice,
        roundEnd,
        marketId:     currentMarket?.id || null,
        priceHistory: priceHistory.slice(-60),
      }));
    }

    // Обробляємо ставки від клієнта
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'bet') {
          handleClientBet(ws, msg);
        }
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`👤 Клієнт відключився (всього: ${clients.size})`);
    });

    ws.on('error', () => clients.delete(ws));
  });

  logger.info(`🚀 WS сервер запущено на порту ${WS_PORT}`);
}

// ── Обробка ставки від клієнта ─────────────
function handleClientBet(ws, msg) {
  const { userId, marketId, side, amount } = msg;

  if (!marketId || !side || !amount || !userId) return;

  const result = db.placeBet({ marketId, userId, side, amount });

  ws.send(JSON.stringify({
    type:    'bet_result',
    success: !result.error,
    error:   result.error || null,
    bet:     result.bet || null,
    balance: result.user?.gems || null,
  }));
}

// ── Запуск ────────────────────────────────
function startBTCLive() {
  logger.info('🚀 BTC Live запускається...');

  // Запускаємо WS сервер для клієнтів
  startWSServer();

  // Підключаємось до Binance
  connectToBinance();

  // Починаємо перший раунд через 2 секунди
  // (щоб встигла прийти перша ціна від Binance)
  setTimeout(startNewRound, 2000);
}

module.exports = { startBTCLive, broadcastPrice };
