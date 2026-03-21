// src/db.js v2
// ════════════════════════════════════════
//  ПУНКТ 2: База даних для 1000+ гравців
//  JSON файл → легко замінити на PostgreSQL
// ════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

const EMPTY_DB = {
  markets: [],
  bets:    [],
  users:   [],
  nextId:  1,
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── USERS ────────────────────────────────

function getOrCreateUser(telegramId, username) {
  const db   = load();
  let user   = db.users.find(u => u.telegramId === telegramId);

  if (!user) {
    user = {
      id:             db.nextId++,
      telegramId,
      username:       username || `user_${telegramId}`,
      gems:           12500,     // стартовий баланс
      wins:           0,
      losses:         0,
      totalBets:      0,
      streak:         0,
      dailyClaimedAt: null,
      pathStep:       0,
      joinedAt:       new Date().toISOString(),
      referredBy:     null,
    };
    db.users.push(user);
    db.nextId++;
    save(db);
  }
  return user;
}

function addGems(userId, amount) {
  const db  = load();
  const idx = db.users.findIndex(u => u.id === userId || u.telegramId === userId);
  if (idx !== -1) {
    db.users[idx].gems += amount;
    save(db);
    return db.users[idx].gems;
  }
  return null;
}

// ── MARKETS ──────────────────────────────

function createMarket(data) {
  const db = load();
  const market = {
    id:           db.nextId++,
    question:     data.question,
    sub:          data.sub         || '',
    room:         data.room        || 'global',
    icon:         data.icon        || '📊',
    deadline:     data.deadline,
    deadlineStr:  data.deadlineStr || '',
    source:       data.source      || '',
    createdBy:    data.createdBy   || 'bot',
    isUserCreated:data.isUserCreated || false,
    tp:           data.tp          || 'new',
    poolYes:      data.poolYes     || 0,
    poolNo:       data.poolNo      || 0,
    status:       'open',
    createdAt:    new Date().toISOString(),
    resolvedAt:   null,
    result:       null,
    resolveNote:  '',
  };
  db.markets.push(market);
  save(db);
  return market;
}

function getMarket(id) {
  return load().markets.find(m => m.id === id) || null;
}

function getOpenMarkets() {
  return load().markets.filter(m => m.status === 'open');
}

function getExpiredMarkets() {
  const now = new Date();
  return load().markets.filter(m =>
    m.status === 'open' && new Date(m.deadline) <= now
  );
}

function updateMarket(id, fields) {
  const db  = load();
  const idx = db.markets.findIndex(m => m.id === id);
  if (idx !== -1) {
    Object.assign(db.markets[idx], fields);
    save(db);
  }
}

// ── BETS ─────────────────────────────────

/**
 * ПУНКТ 2: placeBet з повною валідацією
 */
function placeBet({ marketId, userId, side, amount }) {
  const db     = load();
  const market = db.markets.find(m => m.id === marketId);
  const uIdx   = db.users.findIndex(u => u.id === userId || u.telegramId === userId);

  if (!market)             return { error: 'market_not_found' };
  if (market.status !== 'open') return { error: 'market_closed' };
  if (uIdx === -1)         return { error: 'user_not_found' };

  const user = db.users[uIdx];
  if (user.gems < amount)  return { error: 'insufficient_funds' };

  // Перевіряємо чи вже є ставка
  const existing = db.bets.find(b => b.marketId === marketId && b.userId === user.id);
  if (existing)            return { error: 'already_bet' };

  // Списуємо монети
  db.users[uIdx].gems      -= amount;
  db.users[uIdx].totalBets += 1;

  // Оновлюємо пул
  if (side === 'yes') market.poolYes += amount;
  else                market.poolNo  += amount;

  // Зберігаємо ставку
  const bet = {
    id:        db.nextId++,
    marketId,
    userId:    user.id,
    side,
    amount,
    status:    'pending',
    placedAt:  new Date().toISOString(),
    resolvedAt:null,
    payout:    null,
  };
  db.bets.push(bet);
  save(db);

  return { bet, market, user: db.users[uIdx] };
}

function getBetsForMarket(marketId) {
  return load().bets.filter(b => b.marketId === marketId);
}

module.exports = {
  load, save,
  getOrCreateUser, addGems,
  createMarket, getMarket, getOpenMarkets, getExpiredMarkets, updateMarket,
  placeBet, getBetsForMarket,
};
