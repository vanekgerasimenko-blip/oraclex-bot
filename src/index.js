// src/index.js
require('dotenv').config();
const cron   = require('node-cron');
const logger = require('./logger');
const { generateDailyMarkets } = require('./generator');
const { checkExpiredMarkets }  = require('./oracle');
const { bot, notifyAdminNewMarkets, notifyAdminWeeklyReport } = require('./bot');

// ── Перевірка конфігурації ───────────────
function checkConfig() {
  // ВИПРАВЛЕННЯ 1: прибрали OPENAI_API_KEY — використовуємо Gemini
    const required = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY'];
      const missing  = required.filter(key => !process.env[key]);

        if (missing.length > 0) {
            logger.error(`❌ Відсутні змінні: ${missing.join(', ')}`);
                process.exit(1);
                  }
                    if (!process.env.NEWS_API_KEY) {
                        logger.warn('⚠️  NEWS_API_KEY не встановлено — використовуються fallback шаблони');
                          }
                            logger.info('✅ Конфігурація перевірена');
                            }

                            // ── Cron Розклад ─────────────────────────
                            function startScheduler() {
                              const tz = process.env.TIMEZONE || 'Europe/Kyiv';

                                // 08:00 — генерація нових ринків
                                  cron.schedule('0 8 * * *', async () => {
                                      logger.info('⏰ 08:00 — Генерую щоденні ринки...');
                                          try {
                                                const markets = await generateDailyMarkets();
                                                      await notifyAdminNewMarkets(markets);
                                                          } catch (err) {
                                                                logger.error('❌ Помилка генерації:', err.message);
                                                                    }
                                                                      }, { timezone: tz });

                                                                        // Кожні 5 хвилин — перевірка закінчених ринків
                                                                          cron.schedule('*/5 * * * *', async () => {
                                                                              try {
                                                                                    await checkExpiredMarkets();
                                                                                        } catch (err) {
                                                                                              logger.error('❌ Помилка перевірки:', err.message);
                                                                                                  }
                                                                                                    });

                                                                                                      // 20:00 — вечірня перевірка
                                                                                                        cron.schedule('0 20 * * *', async () => {
                                                                                                            logger.info('⏰ 20:00 — Вечірня перевірка...');
                                                                                                                try { await checkExpiredMarkets(); }
                                                                                                                    catch (err) { logger.error('❌', err.message); }
                                                                                                                      }, { timezone: tz });

                                                                                                                        // Щопонеділка 09:00 — тижневий звіт
                                                                                                                          cron.schedule('0 9 * * 1', async () => {
                                                                                                                              try { await notifyAdminWeeklyReport(); }
                                                                                                                                  catch (err) { logger.error('❌ Помилка звіту:', err.message); }
                                                                                                                                    }, { timezone: tz });

                                                                                                                                      logger.info(`⏰ Планувальник запущено (${tz})`);
                                                                                                                                      }

                                                                                                                                      // ── Запуск ───────────────────────────────
                                                                                                                                      async function main() {
                                                                                                                                        logger.info('🚀 OracleX Bot запускається...');

                                                                                                                                          checkConfig();

                                                                                                                                            // Запускаємо бот
                                                                                                                                              // ВИПРАВЛЕННЯ 2: await bot.launch() щоб зловити помилки
                                                                                                                                                try {
                                                                                                                                                    await bot.launch();
                                                                                                                                                        logger.info('🤖 Telegram бот запущено');
                                                                                                                                                          } catch (err) {
                                                                                                                                                              logger.error('❌ Помилка запуску бота:', err.message);
                                                                                                                                                                  // Не зупиняємо процес — cron і генерація можуть працювати без бота
                                                                                                                                                                    }

                                                                                                                                                                      startScheduler();

                                                                                                                                                                        // Генеруємо ринки якщо немає
                                                                                                                                                                          const { getOpenMarkets } = require('./db');
                                                                                                                                                                            if (getOpenMarkets().length === 0) {
                                                                                                                                                                                logger.info('📭 Немає ринків — генерую перші...');
                                                                                                                                                                                    try {
                                                                                                                                                                                          const markets = await generateDailyMarkets();
                                                                                                                                                                                                await notifyAdminNewMarkets(markets);
                                                                                                                                                                                                      logger.info(`✅ Створено ${markets.length} ринків`);
                                                                                                                                                                                                          } catch (err) {
                                                                                                                                                                                                                logger.error('❌ Помилка початкової генерації:', err.message);
                                                                                                                                                                                                                    }
                                                                                                                                                                                                                      } else {
                                                                                                                                                                                                                          logger.info(`📊 Є ${getOpenMarkets().length} відкритих ринків`);
                                                                                                                                                                                                                            }

                                                                                                                                                                                                                              logger.info('✅ OracleX Bot готовий!');
                                                                                                                                                                                                                              }

                                                                                                                                                                                                                              // Graceful shutdown
                                                                                                                                                                                                                              process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
                                                                                                                                                                                                                              process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

                                                                                                                                                                                                                              main().catch(err => {
                                                                                                                                                                                                                                logger.error('💥 Критична помилка:', err.message);
                                                                                                                                                                                                                                  process.exit(1);
                                                                                                                                                                                                                                  });

                                                                                                                                                                                                                                  