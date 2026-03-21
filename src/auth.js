// src/auth.js
// ════════════════════════════════════════
//  ПУНКТ 3: Авторизація через Telegram initData
//
//  Як це працює:
//  1. Telegram передає initData в Mini App
//  2. Ми верифікуємо підпис через HMAC-SHA256
//  3. Якщо підпис валідний — юзер справжній
//  4. Повертаємо JWT токен для подальших запитів
// ════════════════════════════════════════

const crypto = require('crypto');
const logger = require('./logger');

// ── Верифікація Telegram initData ────────
/**
 * Перевіряє що initData справді від Telegram
 * Документація: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function verifyTelegramAuth(initData, botToken) {
  try {
    // Парсимо initData рядок
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if(!hash) return { valid: false, error: 'no_hash' };

    // Збираємо всі параметри крім hash, сортуємо і з'єднуємо
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256 з секретним ключем
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if(expectedHash !== hash) {
      return { valid: false, error: 'invalid_hash' };
    }

    // Парсимо дані юзера
    const userStr = params.get('user');
    if(!userStr) return { valid: false, error: 'no_user' };

    const user      = JSON.parse(userStr);
    const authDate  = parseInt(params.get('auth_date') || '0');
    const now       = Math.floor(Date.now() / 1000);

    // Перевіряємо що дані не старіші 24 годин
    if(now - authDate > 86400) {
      return { valid: false, error: 'expired' };
    }

    return {
      valid: true,
      user: {
        id:         user.id,
        username:   user.username   || `user_${user.id}`,
        firstName:  user.first_name || '',
        lastName:   user.last_name  || '',
        isPremium:  user.is_premium || false,
        photoUrl:   user.photo_url  || null,
      },
    };

  } catch(err) {
    logger.warn('verifyTelegramAuth error:', err.message);
    return { valid: false, error: 'parse_error' };
  }
}

// ── Простий JWT (без бібліотеки) ─────────
const JWT_SECRET = process.env.JWT_SECRET || 'oraclex_secret_change_in_prod';

function createToken(userId) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    exp: Date.now() + 7 * 24 * 3600 * 1000, // 7 днів
  })).toString('base64url');

  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [payload, sig] = token.split('.');
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(payload)
      .digest('base64url');

    if(sig !== expectedSig) return null;

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if(data.exp < Date.now()) return null; // протермінований

    return data;
  } catch {
    return null;
  }
}

// ── Express Middleware ────────────────────
/**
 * Перевіряє Authorization: Bearer <token> заголовок
 * Додає req.userId якщо токен валідний
 */
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();

  if(!token) {
    return res.status(401).json({ error: 'no_token' });
  }

  const data = verifyToken(token);
  if(!data) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  req.userId = data.userId;
  next();
}

/**
 * М'який middleware — не блокує якщо немає токена
 * Використовується для публічних ендпоінтів
 */
function optionalAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();

  if(token) {
    const data = verifyToken(token);
    if(data) req.userId = data.userId;
  }
  next();
}

module.exports = {
  verifyTelegramAuth,
  createToken,
  verifyToken,
  authMiddleware,
  optionalAuth,
};
