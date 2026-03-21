// src/index.js v2
// ════════════════════════════════════════
//  Запускає Bot + API разом
// ════════════════════════════════════════

require('dotenv').config();
const cron   = require('node-cron');
const logger = require('./logger');
const { generateDailyMarkets } = require('./generator');
const { checkExpiredMarkets }  = require('./oracle');
const { bot, notifyAdminNewMarkets, notifyAdminWeeklyReport } = require('./bot');
const { startAPI } = require('./api');

// ── Перевірка конфігурації ───────────────
function checkConfig() {
  const required = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`❌ Відсутні змінні: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.NEWS_API_KEY) {
    logger.warn('⚠️  NEWS_API_KEY не встановлено — fallback шаблони');
  }
  if (!process.env.JWT_SECRET) {
    logger.warn('⚠️  JWT_SECRET не встановлено — використовується дефолтний!');
  }
  logger.info('✅ Конфігурація перевірена');
}

// ── Cron розклад ─────────────────────────
function startScheduler() {
  const tz = process.env.TIMEZONE || 'Europe/Kyiv';

  cron.schedule('0 8 * * *', async () => {
    logger.info('⏰ 08:00 — Генерую ринки...');
    try {
      const markets = await generateDailyMarkets();
      await notifyAdminNewMarkets(markets);
    } catch (err) { logger.error('❌ Генерація:', err.message); }
  }, { timezone: tz });

  cron.schedule('*/5 * * * *', async () => {
    try { await checkExpiredMarkets(); }
    catch (err) { logger.error('❌ Перевірка:', err.message); }
  });

  cron.schedule('0 20 * * *', async () => {
    try { await checkExpiredMarkets(); }
    catch (err) { logger.error('❌ Вечірня:', err.message); }
  }, { timezone: tz });

  cron.schedule('0 9 * * 1', async () => {
    try { await notifyAdminWeeklyReport(); }
    catch (err) { logger.error('❌ Звіт:', err.message); }
  }, { timezone: tz });

  logger.info(`⏰ Планувальник запущено (${tz})`);
}

// ── Головна функція ──────────────────────
async function main() {
  logger.info('🚀 OracleX запускається...');
  checkConfig();

  // 1. Запускаємо API сервер (пункти 1,2,4,5)
  const API_PORT = parseInt(process.env.PORT) || 3000;
  startAPI(API_PORT);

  // 2. Запускаємо Telegram бот
  try {
    await bot.launch();
    logger.info('🤖 Telegram бот запущено');
  } catch (err) {
    logger.error('❌ Бот:', err.message);
  }

  // 3. Cron
  startScheduler();

  // 4. Генеруємо ринки якщо немає
  const { getOpenMarkets } = require('./db');
  if (getOpenMarkets().length === 0) {
    logger.info('📭 Немає ринків — генерую...');
    try {
      const markets = await generateDailyMarkets();
      await notifyAdminNewMarkets(markets);
      logger.info(`✅ Створено ${markets.length} ринків`);
    } catch (err) {
      logger.error('❌ Початкова генерація:', err.message);
    }
  }

  logger.info('✅ OracleX готовий! Гравців може бути 1000+');
}

process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
main().catch(err => { logger.error('💥', err.message); process.exit(1); });
