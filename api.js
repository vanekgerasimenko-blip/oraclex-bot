// src/api.js v2 — ЗАХИЩЕНА ВЕРСІЯ
// ════════════════════════════════════════
//  Express API з повним захистом від атак
// ════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const db       = require('./db');
const logger   = require('./logger');
const { verifyTelegramAuth, createToken, authMiddleware, optionalAuth } = require('./auth');
const {
  securityHeaders,
  validateRequest,
  createRateLimitMiddleware,
  antiBotDetector,
  opLock,
  replayProtection,
  validateBetAmount,
  safeAddGems,
  detectReferralAbuse,
  logSuspiciousActivity,
  BALANCE_LIMITS,
} = require('./security');

const app = express();

// ════ ГЛОБАЛЬНІ MIDDLEWARE ════
app.use(securityHeaders);                           // Security headers
app.use(express.json({ limit: '10kb' }));          // Обмеження розміру body
app.use(cors({ origin: process.env.WEBAPP_URL || '*',
               methods: ['GET','POST'],
               allowedHeaders: ['Content-Type','Authorization'] }));
app.use(validateRequest);                           // Санітизація inputs
app.use(createRateLimitMiddleware('general'));      // Глобальний rate limit

// Логування
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} [${req.userId||'anon'}]`);
  next();
});

// ════ AUTH ════

app.post('/api/auth/telegram',
  createRateLimitMiddleware('auth'),
  (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'initData required' });

    const result = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);

    // Dev режим
    if (!result.valid && process.env.NODE_ENV === 'development' && req.body.testMode) {
      const testUser = { id: 999999, username: 'test_user', firstName: 'Test', isPremium: false };
      const user     = db.getOrCreateUser(testUser.id, testUser.username);
      return res.json({ token: createToken(testUser.id), user });
    }

    if (!result.valid) {
      logSuspiciousActivity('INVALID_AUTH', { ip: req.ip, reason: result.error });
      return res.status(401).json({ error: result.error });
    }

    const tgUser = result.user;

    // Антибот перевірка при реєстрації
    const botCheck = antiBotDetector.isSuspicious(tgUser.id, 'auth');
    if (botCheck.blocked) {
      logSuspiciousActivity('BOT_DETECTED', { userId: tgUser.id, score: botCheck.score });
      return res.status(429).json({ error: 'suspicious_activity' });
    }

    const user  = db.getOrCreateUser(tgUser.id, tgUser.username);
    const token = createToken(tgUser.id);
    logger.info(`✅ Auth: @${tgUser.username}`);
    res.json({ token, user });
  }
);

// ════ MARKETS ════

app.get('/api/markets', optionalAuth, (req, res) => {
  const page   = Math.max(0, parseInt(req.query.page)   || 0);
  const limit  = Math.min(20, parseInt(req.query.limit) || 20); // макс 20!
  const room   = ['all','ua','global','crypto','us','eu','sports'].includes(req.query.room)
    ? req.query.room : 'all';

  let markets = db.getOpenMarkets();
  if (room !== 'all') markets = markets.filter(m => m.room === room);
  markets.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total  = markets.length;
  const paged  = markets.slice(page * limit, (page+1) * limit);

  res.json({
    markets:    paged.map(m => sanitizeMarketForClient(m, req.userId)),
    pagination: { page, limit, total, hasMore: (page+1)*limit < total },
  });
});

app.get('/api/markets/:id', optionalAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const market = db.getMarket(id);
  if (!market) return res.status(404).json({ error: 'not_found' });
  res.json(sanitizeMarketForClient(market, req.userId));
});

app.post('/api/markets',
  authMiddleware,
  createRateLimitMiddleware('market'),
  async (req, res) => {
    const { question, sub, room, icon, deadlineHours } = req.body;

    // Валідація
    if (!question || question.length < 10 || question.length > 200) {
      return res.status(400).json({ error: 'invalid_question' });
    }
    const validRooms = ['ua','global','crypto','us','eu','sports'];
    if (!validRooms.includes(room)) {
      return res.status(400).json({ error: 'invalid_room' });
    }
    const validHours = [1,3,6,12,24,72,168,336,720];
    if (!validHours.includes(parseInt(deadlineHours))) {
      return res.status(400).json({ error: 'invalid_deadline' });
    }

    // Антибот
    const botCheck = antiBotDetector.isSuspicious(req.userId, 'create_market');
    if (botCheck.blocked) return res.status(429).json({ error: 'suspicious_activity' });

    // Перевіряємо баланс (потрібно 100 для першої ставки)
    const dbData = db.load();
    const user   = dbData.users.find(u => u.telegramId === req.userId);
    if (!user || user.gems < 100) {
      return res.status(400).json({ error: 'insufficient_funds', required: 100 });
    }

    try {
      // AI модерація
      const { moderateUserMarket } = require('./oracle');
      const mod = await moderateUserMarket({ question, sub, room });
      if (!mod.approved) {
        return res.status(400).json({ error: 'moderation_failed', reason: mod.reason });
      }
    } catch(e) { logger.warn('Moderation skipped:', e.message); }

    const deadline = new Date(Date.now() + parseInt(deadlineHours) * 3_600_000).toISOString();
    const market   = db.createMarket({ question, sub: sub||'', room, icon: icon||'📊',
                                       deadline, deadlineStr:`${deadlineHours}г`,
                                       createdBy: req.userId, isUserCreated: true, tp: 'new' });

    logger.info(`✅ Ринок #${market.id} від ${req.userId}`);
    res.json({ market });
  }
);

// ════ BETS (найважливіший захист) ════

app.post('/api/bets',
  authMiddleware,
  createRateLimitMiddleware('bet'),
  async (req, res) => {
    const { marketId, side, amount, nonce } = req.body;
    const userId = req.userId;

    // 1. Перевіряємо nonce — захист від replay attack
    if (!replayProtection.checkNonce(nonce)) {
      logSuspiciousActivity('REPLAY_ATTACK', { userId, marketId, nonce });
      return res.status(400).json({ error: 'duplicate_request' });
    }

    // 2. Антибот
    const botCheck = antiBotDetector.isSuspicious(userId, 'bet');
    if (botCheck.blocked) {
      logSuspiciousActivity('BOT_BET', { userId, score: botCheck.score });
      return res.status(429).json({ error: 'suspicious_activity' });
    }

    // 3. Валідація side
    if (!['yes','no'].includes(side)) {
      return res.status(400).json({ error: 'invalid_side' });
    }

    // 4. Лок — захист від race condition (double-spend)
    const lockKey = `bet:${userId}:${marketId}`;
    try {
      const result = await opLock.withLock(lockKey, async () => {

        // 5. Перевіряємо баланс всередині лока
        const dbData = db.load();
        const user   = dbData.users.find(u => u.telegramId === userId);
        if (!user) return { error: 'user_not_found' };

        // 6. Валідація суми
        const validation = validateBetAmount(parseInt(amount), user.gems);
        if (!validation.valid) return { error: validation.error, ...validation };

        // 7. Перевіряємо ринок
        const market = dbData.markets.find(m => m.id === parseInt(marketId));
        if (!market)              return { error: 'market_not_found' };
        if (market.status !== 'open') return { error: 'market_closed' };

        // 8. Дедлайн
        if (new Date(market.deadline) <= new Date()) return { error: 'market_expired' };

        // 9. Повторна ставка
        if (dbData.bets.find(b => b.marketId === market.id && b.userId === user.id)) {
          return { error: 'already_bet' };
        }

        // 10. Атомарне оновлення балансу (safeAddGems запобігає від'ємному)
        const betAmount = parseInt(amount);
        const uIdx = dbData.users.findIndex(u => u.telegramId === userId);
        dbData.users[uIdx].gems      = safeAddGems(user.gems, -betAmount);
        dbData.users[uIdx].totalBets += 1;

        // 11. Оновлюємо пул
        const mIdx = dbData.markets.findIndex(m => m.id === market.id);
        if (side === 'yes') dbData.markets[mIdx].poolYes += betAmount;
        else                dbData.markets[mIdx].poolNo  += betAmount;

        // 12. Зберігаємо ставку
        const bet = {
          id:         dbData.nextId++,
          marketId:   market.id,
          userId:     user.id,
          side,
          amount:     betAmount,
          status:     'pending',
          placedAt:   new Date().toISOString(),
          resolvedAt: null,
          payout:     null,
          nonce,
        };
        dbData.bets.push(bet);
        db.save(dbData);

        logger.info(`💰 Ставка: user=${user.id} market=${market.id} side=${side} amount=${betAmount}`);
        return {
          bet,
          newBalance: dbData.users[uIdx].gems,
          market: {
            id: market.id,
            poolYes: dbData.markets[mIdx].poolYes,
            poolNo:  dbData.markets[mIdx].poolNo,
          },
        };
      });

      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ success: true, ...result });

    } catch (err) {
      if (err.message.startsWith('already_processing')) {
        return res.status(409).json({ error: 'already_processing' });
      }
      logger.error('Bet error:', err.message);
      res.status(500).json({ error: 'server_error' });
    }
  }
);

// ════ USERS ════

app.get('/api/users/me', authMiddleware, (req, res) => {
  const dbData = db.load();
  const user   = dbData.users.find(u => u.telegramId === req.userId);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const bets   = dbData.bets.filter(b => b.userId === user.id);
  const wins   = bets.filter(b => b.status === 'won').length;
  const losses = bets.filter(b => b.status === 'lost').length;

  // Повертаємо тільки безпечні поля (не повертаємо токени тощо)
  res.json({
    id:             user.id,
    username:       user.username,
    gems:           user.gems,
    wins,
    losses,
    totalBets:      bets.length,
    winRate:        bets.length > 0 ? Math.round(wins/bets.length*100) : 0,
    streak:         user.streak || 0,
    joinedAt:       user.joinedAt,
    dailyClaimedAt: user.dailyClaimedAt || null,
    pathStep:       user.pathStep       || 0,
  });
});

app.post('/api/users/daily',
  authMiddleware,
  createRateLimitMiddleware('daily'),
  async (req, res) => {
    const lockKey = `daily:${req.userId}`;
    try {
      const result = await opLock.withLock(lockKey, async () => {
        const dbData = db.load();
        const uIdx   = dbData.users.findIndex(u => u.telegramId === req.userId);
        if (uIdx === -1) return { error: 'not_found' };

        const user  = dbData.users[uIdx];
        const now   = Date.now();
        const MS24  = 86_400_000;
        const last  = user.dailyClaimedAt || 0;

        if (now - last < MS24) {
          return { error: 'already_claimed', msLeft: MS24 - (now - last) };
        }

        const REWARD = 250;
        dbData.users[uIdx].gems          = safeAddGems(user.gems, REWARD);
        dbData.users[uIdx].streak        = (user.streak || 0) + 1;
        dbData.users[uIdx].dailyClaimedAt = now;
        db.save(dbData);

        return { success: true, reward: REWARD,
                 gems: dbData.users[uIdx].gems,
                 streak: dbData.users[uIdx].streak };
      });

      if (result.error === 'already_claimed') {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch(err) {
      res.status(500).json({ error: 'server_error' });
    }
  }
);

app.post('/api/users/me/sync', authMiddleware, (req, res) => {
  const { pathStep, streak, dailyClaimedAt } = req.body;
  const dbData = db.load();
  const uIdx   = dbData.users.findIndex(u => u.telegramId === req.userId);
  if (uIdx === -1) return res.status(404).json({ error: 'not_found' });

  // Синхронізуємо тільки безпечні поля
  // gems — НІКОЛИ не беремо з клієнта, тільки з сервера
  if (typeof pathStep === 'number' && pathStep >= 0 && pathStep <= 20) {
    dbData.users[uIdx].pathStep = pathStep;
  }
  if (typeof streak === 'number' && streak >= 0) {
    dbData.users[uIdx].streak = streak;
  }
  if (dailyClaimedAt && typeof dailyClaimedAt === 'number') {
    dbData.users[uIdx].dailyClaimedAt = dailyClaimedAt;
  }
  db.save(dbData);

  // Завжди повертаємо серверний баланс — клієнт не може його підробити
  res.json({ success: true, gems: dbData.users[uIdx].gems });
});

app.get('/api/users/leaderboard', (req, res) => {
  const limit  = Math.min(50, parseInt(req.query.limit) || 10);
  const dbData = db.load();
  const leaders = dbData.users
    .sort((a,b) => b.gems - a.gems)
    .slice(0, limit)
    .map((u, i) => ({
      rank:     i + 1,
      username: u.username,
      gems:     u.gems,
      wins:     u.wins || 0,
    }));
  res.json({ leaders });
});

// ════ HEALTH ════
app.get('/api/health', (req, res) => {
  const dbData = db.load();
  res.json({
    status:   'ok',
    markets:  dbData.markets.filter(m => m.status === 'open').length,
    users:    dbData.users.length,
    uptime:   Math.floor(process.uptime()),
    version:  '2.0.0',
  });
});

// 404 і Error handlers
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'server_error' });
});

// ── Helpers ──────────────────────────────
function sanitizeMarketForClient(m, userId) {
  const data   = db.load();
  const userBet = userId
    ? data.bets.find(b => b.marketId === m.id && b.userId === userId) || null
    : null;

  return {
    id:          m.id,
    question:    m.question,
    sub:         m.sub,
    room:        m.room,
    icon:        m.icon,
    deadlineStr: m.deadlineStr,
    deadline:    m.deadline,
    tp:          m.tp,
    poolYes:     m.poolYes,
    poolNo:      m.poolNo,
    status:      m.status,
    createdAt:   m.createdAt,
    yesPct:      calcYesPct(m),
    myBet:       userBet,
    // НЕ повертаємо: source, resolveNote, createdBy (внутрішні поля)
  };
}

function calcYesPct(m) {
  const t = m.poolYes + m.poolNo;
  return t === 0 ? 50 : Math.round(m.poolYes / t * 100);
}

function startAPI(port = 3000) {
  app.listen(port, () => {
    logger.info(`🚀 API на порту ${port}`);
    logger.info(`   Health: http://localhost:${port}/api/health`);
  });
  return app;
}

module.exports = { app, startAPI };
