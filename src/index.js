// src/index.js
// ════════════════════════════════════════
//  ORACLEX BOT — ГОЛОВНИЙ ФАЙЛ
//
//  Запускає:
//  1. Telegram бот
//  2. Cron розклад
//  3. Всі автоматичні перевірки
// ════════════════════════════════════════

require('dotenv').config();
const cron    = require('node-cron');
const logger  = require('./logger');
const { generateDailyMarkets }  = require('./generator');
const { checkExpiredMarkets }   = require('./oracle');
const { bot, notifyAdminNewMarkets } = require('./bot');

// ── Перевірка конфігурації ───────────────
function checkConfig() {
  const required = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY'];
  const missing  = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    logger.error(`❌ Відсутні змінні середовища: ${missing.join(', ')}`);
    logger.error('Скопіюй .env.example у .env і заповни ключі');
    process.exit(1);
  }

  if (!process.env.NEWS_API_KEY) {
    logger.warn('⚠️  NEWS_API_KEY не встановлено — будуть використані fallback шаблони');
  }

  logger.info('✅ Конфігурація перевірена');
}

// ── Cron Розклад ─────────────────────────
function startScheduler() {
  const tz = process.env.TIMEZONE || 'Europe/Kyiv';

  // ─── Щодня о 08:00 — генерувати нові ринки
  cron.schedule('0 8 * * *', async () => {
    logger.info('⏰ 08:00 — Генерую щоденні ринки...');
    try {
      const markets = await generateDailyMarkets();
      await notifyAdminNewMarkets(markets);
      logger.info(`✅ Створено ${markets.length} ринків`);
    } catch (err) {
      logger.error('❌ Помилка генерації:', err.message);
    }
  }, { timezone: tz });

  // ─── Кожні 5 хвилин — перевіряти закінчені ринки
  cron.schedule('*/5 * * * *', async () => {
    try {
      const resolved = await checkExpiredMarkets();
      if (resolved.length > 0) {
        logger.info(`⚡ Вирішено ${resolved.length} ринків`);
      }
    } catch (err) {
      logger.error('❌ Помилка перевірки ринків:', err.message);
    }
  });

  // ─── Щодня о 09:00 — вечірня повторна перевірка
  cron.schedule('0 20 * * *', async () => {
    logger.info('⏰ 20:00 — Вечірня перевірка ринків...');
    try {
      await checkExpiredMarkets();
    } catch (err) {
      logger.error('❌ Помилка вечірньої перевірки:', err.message);
    }
  }, { timezone: tz });

  // ─── Щопонеділка о 09:00 — тижневий звіт адміну
  cron.schedule('0 9 * * 1', async () => {
    logger.info('📊 Тижневий звіт...');
    const db_data = require('./db').load();
    const stats = {
      totalMarkets:   db_data.markets.length,
      openMarkets:    db_data.markets.filter(m => m.status === 'open').length,
      resolvedToday:  db_data.markets.filter(m =>
        m.resolvedAt && m.resolvedAt.startsWith(new Date().toISOString().slice(0, 10))
      ).length,
      totalBets:      db_data.bets.length,
      totalUsers:     db_data.users.length,
    };
    logger.info('📊 Статистика:', JSON.stringify(stats));
  }, { timezone: tz });

  logger.info('⏰ Планувальник запущено (часовий пояс: ' + tz + ')');
}

// ── Запуск ───────────────────────────────
async function main() {
  logger.info('🚀 OracleX Bot запускається...');

  // 1. Перевірка конфігурації
  checkConfig();

  // 2. Запускаємо Telegram бот
  bot.launch()
    .then(() => logger.info('🤖 Telegram бот запущено'))
    .catch(err => logger.error('❌ Помилка запуску бота:', err.message));

  // 3. Запускаємо планувальник
  startScheduler();

  // 4. При першому запуску — одразу генеруємо ринки (якщо їх немає)
  const { getOpenMarkets } = require('./db');
  const existing = getOpenMarkets();

  if (existing.length === 0) {
    logger.info('📭 Немає відкритих ринків — генерую перші...');
    try {
      const markets = await generateDailyMarkets();
      await notifyAdminNewMarkets(markets);
      logger.info(`✅ Початкові ринки створені: ${markets.length}`);
    } catch (err) {
      logger.error('❌ Помилка початкової генерації:', err.message);
    }
  } else {
    logger.info(`📊 Є ${existing.length} відкритих ринків`);
  }

  logger.info('✅ OracleX Bot готовий до роботи!');
}

// ── Graceful Shutdown ────────────────────
process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

main().catch(err => {
  logger.error('💥 Критична помилка:', err);
  process.exit(1);
});
