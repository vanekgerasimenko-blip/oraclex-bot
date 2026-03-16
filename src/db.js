// src/db.js
// ════════════════════════════════════════
//  База даних — починаємо з JSON файлу.
//  Легко замінити на PostgreSQL пізніше.
// ════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

// Початкова структура бази
const EMPTY_DB = {
  markets: [],       // всі ринки
  bets:    [],       // всі ставки
  users:   [],       // гравці
  nextId:  1,
};

// ── Завантажити / зберегти ──────────────

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── MARKETS ─────────────────────────────

/**
 * Створити новий ринок
 * @param {Object} data - { question, sub, room, icon, deadline, source, createdBy }
 * @returns {Object} ринок
 */
function createMarket(data) {
  const db = load();
  const market = {
    id:          db.nextId++,
    question:    data.question,
    sub:         data.sub || '',
    room:        data.room || 'global',
    icon:        data.icon || '📊',
    deadline:    data.deadline,           // ISO string
    deadlineStr: data.deadlineStr || '',  // "3д 00:00" для UI
    source:      data.source || '',       // URL джерела правди
    status:      'open',                  // open | closed | resolved | cancelled
    result:      null,                    // 'yes' | 'no' | 'refund'
    poolYes:     data.initialBet && data.initialSide === 'yes' ? data.initialBet : 0,
    poolNo:      data.initialBet && data.initialSide === 'no'  ? data.initialBet : 0,
    tp:          data.tp || 'new',        // flash | mega | hot | new
    createdBy:   data.createdBy || 'bot', // 'bot' або userId
    createdAt:   new Date().toISOString(),
    resolvedAt:  null,
    resolveNote: '',                      // пояснення результату
    isUserCreated: data.isUserCreated || false,
  };
  db.markets.push(market);
  db.nextId = db.nextId;
  save(db);
  return market;
}

/** Отримати всі відкриті ринки */
function getOpenMarkets() {
  const db = load();
  return db.markets.filter(m => m.status === 'open');
}

/** Отримати ринки що мають бути вирішені (дедлайн минув) */
function getExpiredMarkets() {
  const db = load();
  const now = new Date();
  return db.markets.filter(m =>
    m.status === 'open' &&
    new Date(m.deadline) <= now
  );
}

/** Отримати ринок за ID */
function getMarket(id) {
  const db = load();
  return db.markets.find(m => m.id === id) || null;
}

/** Оновити ринок */
function updateMarket(id, updates) {
  const db = load();
  const idx = db.markets.findIndex(m => m.id === id);
  if (idx === -1) return null;
  db.markets[idx] = { ...db.markets[idx], ...updates };
  save(db);
  return db.markets[idx];
}

// ── BETS ────────────────────────────────

/**
 * Зробити ставку
 * @param {Object} data - { marketId, userId, side, amount }
 */
function placeBet(data) {
  const db = load();

  // Перевірка: вже є ставка?
  const existing = db.bets.find(
    b => b.marketId === data.marketId && b.userId === data.userId
  );
  if (existing) return { error: 'already_bet' };

  // Перевірка: ринок відкритий?
  const market = db.markets.find(m => m.id === data.marketId);
  if (!market || market.status !== 'open') return { error: 'market_closed' };

  // Перевірка балансу
  const user = db.users.find(u => u.id === data.userId);
  if (!user || user.gems < data.amount) return { error: 'insufficient_funds' };

  // Оновлюємо пул ринку
  const mIdx = db.markets.findIndex(m => m.id === data.marketId);
  if (data.side === 'yes') db.markets[mIdx].poolYes += data.amount;
  else                     db.markets[mIdx].poolNo  += data.amount;

  // Списуємо монети
  const uIdx = db.users.findIndex(u => u.id === data.userId);
  db.users[uIdx].gems -= data.amount;

  // Записуємо ставку
  const bet = {
    id:        db.nextId++,
    marketId:  data.marketId,
    userId:    data.userId,
    side:      data.side,
    amount:    data.amount,
    payout:    null,    // заповнюється при вирішенні
    status:    'pending',
    placedAt:  new Date().toISOString(),
  };
  db.bets.push(bet);
  save(db);
  return { success: true, bet, market: db.markets[mIdx] };
}

/** Отримати всі ставки на ринок */
function getBetsForMarket(marketId) {
  const db = load();
  return db.bets.filter(b => b.marketId === marketId);
}

// ── USERS ────────────────────────────────

/** Отримати або створити гравця */
function getOrCreateUser(telegramId, username) {
  const db = load();
  let user = db.users.find(u => u.telegramId === telegramId);
  if (!user) {
    user = {
      id:         db.nextId++,
      telegramId,
      username:   username || `user_${telegramId}`,
      gems:       1000,      // стартовий баланс
      wins:       0,
      losses:     0,
      totalBets:  0,
      joinedAt:   new Date().toISOString(),
    };
    db.users.push(user);
    save(db);
  }
  return user;
}

/** Нарахувати монети гравцю */
function addGems(userId, amount) {
  const db = load();
  const idx = db.users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  db.users[idx].gems += amount;
  save(db);
  return db.users[idx];
}

module.exports = {
  createMarket,
  getOpenMarkets,
  getExpiredMarkets,
  getMarket,
  updateMarket,
  placeBet,
  getBetsForMarket,
  getOrCreateUser,
  addGems,
  load,
  save,
};
