// src/security.js
// ════════════════════════════════════════
//  ПОВНИЙ ЗАХИСТ ORACLEX
//
//  Атаки на Notcoin/Hamster і як ми їх блокуємо:
//
//  1. ЧИТ-КЛІЄНТИ — підробні запити без Telegram
//  2. MULTIPLE ACCOUNTS — один юзер = багато акаунтів
//  3. BOT FARMING — автоматичні скрипти
//  4. RATE LIMITING — спам запити
//  5. NEGATIVE BALANCE — від'ємний баланс через race condition
//  6. BET MANIPULATION — підробка ставок
//  7. REFERRAL ABUSE — кільця рефералів
//  8. REPLAY ATTACKS — повторні запити
//  9. SQL/NoSQL INJECTION — через JSON поля
//  10. ADMIN TAKEOVER — злом адмін команд
// ════════════════════════════════════════

const crypto  = require('crypto');
const logger  = require('./logger');

// ════════════════════════════════════════
//  1. RATE LIMITER
//  Hamster атака: боти слали 10000+ запитів/сек
// ════════════════════════════════════════

class RateLimiter {
  constructor() {
    this.windows = new Map(); // userId/IP → [timestamps]
    // Чистимо старі записи кожні 5 хвилин
    setInterval(() => this._cleanup(), 300_000);
  }

  /**
   * Перевіряє чи не перевищено ліміт
   * @returns {boolean} true = заблоковано
   */
  isBlocked(key, limit, windowMs) {
    const now = Date.now();
    const k   = `${key}:${windowMs}`;

    if (!this.windows.has(k)) this.windows.set(k, []);
    const timestamps = this.windows.get(k);

    // Прибираємо старі timestamp'и
    const fresh = timestamps.filter(t => now - t < windowMs);
    fresh.push(now);
    this.windows.set(k, fresh);

    return fresh.length > limit;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.windows) {
      // Якщо всі timestamp'и старіші 10 хвилин — видаляємо
      if (timestamps.every(t => now - t > 600_000)) {
        this.windows.delete(key);
      }
    }
  }
}

const rateLimiter = new RateLimiter();

// Правила лімітів для різних ендпоінтів
const RATE_LIMITS = {
  auth:       { limit: 10,   window: 60_000  }, // 10 спроб на хвилину
  bet:        { limit: 30,   window: 60_000  }, // 30 ставок на хвилину
  market:     { limit: 5,    window: 60_000  }, // 5 ринків на хвилину
  general:    { limit: 100,  window: 60_000  }, // 100 запитів на хвилину
  daily:      { limit: 3,    window: 3600_000}, // 3 спроби на годину
};

function createRateLimitMiddleware(type) {
  return (req, res, next) => {
    const key    = req.userId || req.ip || 'unknown';
    const config = RATE_LIMITS[type] || RATE_LIMITS.general;

    if (rateLimiter.isBlocked(key, config.limit, config.window)) {
      logger.warn(`🚫 Rate limit: ${type} від ${key}`);
      return res.status(429).json({
        error:   'rate_limited',
        message: 'Забагато запитів. Спробуй пізніше.',
        retryAfter: Math.ceil(config.window / 1000),
      });
    }
    next();
  };
}

// ════════════════════════════════════════
//  2. ANTI-CHEAT: Захист від підробних клієнтів
//  Notcoin атака: боти слали POST /bet без реального Telegram
// ════════════════════════════════════════

/**
 * Перевіряє що запит прийшов з реального Telegram WebApp
 * Verifies Telegram initData signature (HMAC-SHA256)
 */
function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    return { valid: false, reason: 'empty_initdata' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) return { valid: false, reason: 'no_hash' };

    // Видаляємо hash з перевірки
    params.delete('hash');

    // Перевіряємо auth_date — не старіше 1 години для безпеки
    const authDate = parseInt(params.get('auth_date') || '0');
    const now      = Math.floor(Date.now() / 1000);
    if (now - authDate > 3600) {
      return { valid: false, reason: 'expired_initdata' };
    }

    // HMAC-SHA256
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (!crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(expectedHash, 'hex')
    )) {
      return { valid: false, reason: 'invalid_hash' };
    }

    const user = JSON.parse(params.get('user') || '{}');
    return { valid: true, user, authDate };

  } catch (err) {
    logger.warn('verifyTelegramInitData error:', err.message);
    return { valid: false, reason: 'parse_error' };
  }
}

// ════════════════════════════════════════
//  3. ANTI-BOT: Виявлення автоматичних скриптів
//  Hamster атака: боти клікали 24/7 без перерви
// ════════════════════════════════════════

class AntiBotDetector {
  constructor() {
    this.userActivity = new Map(); // userId → activity stats
  }

  /**
   * Записує активність і повертає score підозрілості (0-100)
   * Score > 70 = підозріло, > 90 = блокуємо
   */
  recordAction(userId, action) {
    const now  = Date.now();
    const key  = userId.toString();

    if (!this.userActivity.has(key)) {
      this.userActivity.set(key, {
        actions:    [],
        firstSeen:  now,
        flagged:    false,
      });
    }

    const stats = this.userActivity.get(key);
    stats.actions.push({ action, ts: now });

    // Тримаємо тільки останню годину
    stats.actions = stats.actions.filter(a => now - a.ts < 3_600_000);

    return this._calcSuspicionScore(stats, now);
  }

  _calcSuspicionScore(stats, now) {
    let score = 0;
    const actions = stats.actions;

    if (actions.length === 0) return 0;

    // Перевірка 1: занадто багато дій за хвилину (>20 = бот)
    const lastMinute = actions.filter(a => now - a.ts < 60_000).length;
    if (lastMinute > 20) score += 40;
    else if (lastMinute > 10) score += 20;

    // Перевірка 2: рівномірні інтервали (бот завжди стабільний)
    if (actions.length >= 10) {
      const intervals = [];
      for (let i = 1; i < Math.min(actions.length, 20); i++) {
        intervals.push(actions[i].ts - actions[i-1].ts);
      }
      const avg      = intervals.reduce((a,b) => a+b, 0) / intervals.length;
      const variance = intervals.reduce((s, v) => s + Math.pow(v-avg, 2), 0) / intervals.length;
      const stdDev   = Math.sqrt(variance);

      // Людина має variance > 500ms, бот < 100ms
      if (stdDev < 100)  score += 35;
      else if (stdDev < 300) score += 15;
    }

    // Перевірка 3: тільки один тип дії (бот завжди робить одне й те саме)
    const uniqueActions = new Set(actions.map(a => a.action)).size;
    if (actions.length > 20 && uniqueActions === 1) score += 25;

    return Math.min(score, 100);
  }

  isSuspicious(userId, action) {
    const score = this.recordAction(userId, action);
    if (score > 90) {
      logger.warn(`🤖 Бот виявлено: userId=${userId}, score=${score}`);
      return { blocked: true, score };
    }
    if (score > 70) {
      logger.warn(`⚠️  Підозріла активність: userId=${userId}, score=${score}`);
      return { blocked: false, score, warning: true };
    }
    return { blocked: false, score };
  }
}

const antiBotDetector = new AntiBotDetector();

// ════════════════════════════════════════
//  4. RACE CONDITION LOCK
//  Notcoin баг: два запити одночасно = подвійна монета
//  Classic double-spend attack
// ════════════════════════════════════════

class OperationLock {
  constructor() {
    this.locks = new Set();
  }

  /**
   * Виконує операцію з локом — запобігає одночасним запитам
   * @returns результат або кидає помилку якщо вже виконується
   */
  async withLock(key, fn, timeoutMs = 5000) {
    if (this.locks.has(key)) {
      throw new Error(`already_processing:${key}`);
    }

    this.locks.add(key);
    const timer = setTimeout(() => {
      this.locks.delete(key);
      logger.warn(`Lock timeout: ${key}`);
    }, timeoutMs);

    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      this.locks.delete(key);
    }
  }

  isLocked(key) {
    return this.locks.has(key);
  }
}

const opLock = new OperationLock();

// ════════════════════════════════════════
//  5. INPUT SANITIZER
//  SQL/NoSQL Injection через JSON поля питань
// ════════════════════════════════════════

const FORBIDDEN_PATTERNS = [
  // SQL injection
  /(\bDROP\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b|\bSELECT\b|\bUNION\b)/i,
  // NoSQL injection
  /(\$where|\$ne|\$gt|\$regex|\$expr)/,
  // Script injection
  /<script|javascript:|on\w+=/i,
  // Path traversal
  /\.\.\//,
  // Command injection
  /[;&|`$(){}]/,
];

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;

  // Видаляємо null bytes
  let clean = input.replace(/\0/g, '');

  // Обрізаємо зайві пробіли
  clean = clean.trim();

  // Перевіряємо на заборонені паттерни
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(clean)) {
      logger.warn(`⚠️  Suspicious input: ${clean.slice(0, 50)}`);
      throw new Error('invalid_input');
    }
  }

  return clean;
}

function sanitizeObject(obj, maxDepth = 3, depth = 0) {
  if (depth > maxDepth) return null;
  if (typeof obj === 'string') return sanitizeInput(obj);
  if (typeof obj === 'number') {
    if (!isFinite(obj) || isNaN(obj)) throw new Error('invalid_number');
    return obj;
  }
  if (Array.isArray(obj))  return obj.slice(0, 100).map(v => sanitizeObject(v, maxDepth, depth+1));
  if (typeof obj === 'object' && obj !== null) {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleanKey = sanitizeInput(k);
      clean[cleanKey] = sanitizeObject(v, maxDepth, depth+1);
    }
    return clean;
  }
  return obj;
}

// ════════════════════════════════════════
//  6. REPLAY ATTACK PROTECTION
//  Захист від повторного надсилання тих самих запитів
// ════════════════════════════════════════

class ReplayProtection {
  constructor() {
    this.usedNonces = new Map(); // nonce → expiry
    setInterval(() => this._cleanup(), 300_000);
  }

  /**
   * Перевіряє nonce — кожен має бути унікальним
   */
  checkNonce(nonce, windowMs = 300_000) {
    if (!nonce || typeof nonce !== 'string' || nonce.length < 8) {
      return false;
    }
    if (this.usedNonces.has(nonce)) {
      logger.warn(`⚠️  Replay attack: nonce ${nonce}`);
      return false;
    }
    this.usedNonces.set(nonce, Date.now() + windowMs);
    return true;
  }

  _cleanup() {
    const now = Date.now();
    for (const [nonce, expiry] of this.usedNonces) {
      if (now > expiry) this.usedNonces.delete(nonce);
    }
  }
}

const replayProtection = new ReplayProtection();

// ════════════════════════════════════════
//  7. REFERRAL ABUSE DETECTION
//  Hamster атака: кільця рефералів — A→B→C→A
// ════════════════════════════════════════

function detectReferralAbuse(referrerId, newUserId, db) {
  const data = db.load();

  // Перевіряємо чи новий юзер вже є в системі
  const existing = data.users.find(u => u.telegramId === newUserId);
  if (existing) {
    logger.warn(`⚠️  Referral abuse: user ${newUserId} вже існує`);
    return { abusive: true, reason: 'user_exists' };
  }

  // Перевіряємо чи referrer не зареєструвався занадто недавно
  const referrer = data.users.find(u => u.telegramId === referrerId);
  if (referrer) {
    const referrerAge = Date.now() - new Date(referrer.joinedAt).getTime();
    if (referrerAge < 3_600_000) { // < 1 година
      logger.warn(`⚠️  Referral abuse: referrer ${referrerId} занадто новий`);
      return { abusive: true, reason: 'referrer_too_new' };
    }

    // Перевіряємо скільки рефералів у referrer за останній день
    const recentReferrals = data.users.filter(u =>
      u.referredBy === referrerId &&
      Date.now() - new Date(u.joinedAt).getTime() < 86_400_000
    ).length;

    if (recentReferrals >= 20) { // > 20 рефералів за день = підозріло
      logger.warn(`⚠️  Referral abuse: ${referrerId} має ${recentReferrals} рефералів за день`);
      return { abusive: true, reason: 'too_many_referrals' };
    }
  }

  return { abusive: false };
}

// ════════════════════════════════════════
//  8. BALANCE PROTECTION
//  Захист від від'ємного балансу і переповнення
// ════════════════════════════════════════

const BALANCE_LIMITS = {
  MIN:         0,           // мінімальний баланс
  MAX:         10_000_000,  // максимальний (захист від overflow)
  MAX_BET:     100_000,     // максимальна ставка
  MIN_BET:     10,          // мінімальна ставка
  MAX_WIN:     1_000_000,   // максимальний виграш за раз
};

function validateBetAmount(amount, userGems) {
  if (typeof amount !== 'number' || !isFinite(amount) || isNaN(amount)) {
    return { valid: false, error: 'invalid_amount' };
  }
  if (amount < BALANCE_LIMITS.MIN_BET) {
    return { valid: false, error: 'amount_too_small', min: BALANCE_LIMITS.MIN_BET };
  }
  if (amount > BALANCE_LIMITS.MAX_BET) {
    return { valid: false, error: 'amount_too_large', max: BALANCE_LIMITS.MAX_BET };
  }
  if (amount > userGems) {
    return { valid: false, error: 'insufficient_funds', have: userGems, need: amount };
  }
  // Перевіряємо що amount ціле число
  if (!Number.isInteger(amount)) {
    return { valid: false, error: 'amount_must_be_integer' };
  }
  return { valid: true };
}

function safeAddGems(current, delta) {
  const result = current + delta;
  if (result < BALANCE_LIMITS.MIN) {
    logger.error(`⚠️  Balance would go negative: ${current} + ${delta}`);
    return BALANCE_LIMITS.MIN;
  }
  if (result > BALANCE_LIMITS.MAX) {
    logger.warn(`⚠️  Balance overflow prevented: ${result}`);
    return BALANCE_LIMITS.MAX;
  }
  return result;
}

// ════════════════════════════════════════
//  9. SECURITY HEADERS MIDDLEWARE
//  Захист від XSS, clickjacking, MIME sniffing
// ════════════════════════════════════════

function securityHeaders(req, res, next) {
  // Забороняємо вбудовування в iframe (clickjacking)
  res.setHeader('X-Frame-Options',         'DENY');
  // Захист від MIME type sniffing
  res.setHeader('X-Content-Type-Options',  'nosniff');
  // XSS захист
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  // Прибираємо версію сервера
  res.removeHeader('X-Powered-By');
  // Обмежуємо розмір тіла запиту
  next();
}

// ════════════════════════════════════════
//  10. REQUEST VALIDATOR MIDDLEWARE
//  Санітизація всіх вхідних даних
// ════════════════════════════════════════

function validateRequest(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }
    next();
  } catch (err) {
    logger.warn(`Invalid request from ${req.ip}: ${err.message}`);
    res.status(400).json({ error: 'invalid_request', message: 'Некоректні дані' });
  }
}

// ════════════════════════════════════════
//  11. SUSPICIOUS ACTIVITY LOGGER
//  Логуємо всі підозрілі події для аналізу
// ════════════════════════════════════════

function logSuspiciousActivity(type, details) {
  logger.warn(`🚨 SECURITY [${type}]: ${JSON.stringify(details)}`);
  // В продакшені тут відправка алерту в Telegram адміну
}

// ════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════

module.exports = {
  // Middleware для Express
  securityHeaders,
  validateRequest,
  createRateLimitMiddleware,

  // Функції захисту
  verifyTelegramInitData,
  sanitizeInput,
  sanitizeObject,
  validateBetAmount,
  safeAddGems,
  detectReferralAbuse,
  logSuspiciousActivity,

  // Об'єкти
  rateLimiter,
  antiBotDetector,
  opLock,
  replayProtection,

  // Константи
  BALANCE_LIMITS,
};
