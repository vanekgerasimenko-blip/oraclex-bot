// src/test.js
// ════════════════════════════════════════
//  ТЕСТ — запуск без Telegram бота
//  node src/test.js
// ════════════════════════════════════════

require('dotenv').config();
const logger = require('./logger');

async function test() {
  logger.info('🧪 Починаю тестування...\n');

  // ── ТЕСТ 1: Генератор ─────────────────
  logger.info('═══ ТЕСТ 1: Генерація ринків ═══');
  try {
    const { generateDailyMarkets } = require('./generator');
    const markets = await generateDailyMarkets();
    logger.info(`✅ Згенеровано ${markets.length} ринків:`);
    markets.slice(0, 3).forEach((m, i) => {
      logger.info(`  ${i+1}. [${m.room}] ${m.question}`);
    });
  } catch (err) {
    logger.error('❌ Помилка генератора:', err.message);
  }

  console.log('');

  // ── ТЕСТ 2: Крипто оракул ─────────────
  logger.info('═══ ТЕСТ 2: Крипто верифікація ═══');
  try {
    const { verifyCrypto } = require('./oracle');
    const testMarket = {
      id: 999,
      question: 'Bitcoin перевищить $50,000?',
      sub: 'Тест',
      room: 'crypto',
      deadline: new Date().toISOString(),
    };
    const result = await verifyCrypto(testMarket);
    logger.info(`✅ Крипто результат: ${JSON.stringify(result)}`);
  } catch (err) {
    logger.error('❌ Помилка крипто оракула:', err.message);
  }

  console.log('');

  // ── ТЕСТ 3: AI верифікація ────────────
  logger.info('═══ ТЕСТ 3: AI верифікація ═══');
  try {
    const { verifyWithAI } = require('./oracle');
    const testMarket = {
      id: 998,
      question: 'ChatGPT є найпопулярнішим AI інструментом у 2024?',
      sub: 'Тест AI верифікації',
      room: 'tech',
      deadline: new Date(Date.now() - 1000).toISOString(),
      source: 'https://openai.com',
    };
    const result = await verifyWithAI(testMarket);
    logger.info(`✅ AI результат: ${JSON.stringify(result)}`);
  } catch (err) {
    logger.error('❌ Помилка AI верифікації:', err.message);
  }

  console.log('');

  // ── ТЕСТ 4: Модерація гравця ──────────
  logger.info('═══ ТЕСТ 4: Модерація гравця ═══');
  try {
    const { moderateUserMarket } = require('./oracle');
    const goodMarket = {
      question: 'Реал Мадрид виграє Лігу Чемпіонів цього сезону?',
      sub: 'Фінал ЛЧ 2026',
      room: 'sports',
    };
    const badMarket = {
      question: 'Мій сусід Вася хороша людина?',
      sub: 'особисте питання',
      room: 'global',
    };

    const good = await moderateUserMarket(goodMarket);
    const bad  = await moderateUserMarket(badMarket);

    logger.info(`✅ Хороший ринок: ${good.approved ? 'СХВАЛЕНО' : 'ВІДХИЛЕНО'} — ${good.reason}`);
    logger.info(`✅ Поганий ринок: ${bad.approved ? 'СХВАЛЕНО' : 'ВІДХИЛЕНО'} — ${bad.reason}`);
  } catch (err) {
    logger.error('❌ Помилка модерації:', err.message);
  }

  console.log('');

  // ── Підсумок ─────────────────────────
  const db_data = require('./db').load();
  logger.info('═══ ПІДСУМОК БАЗИ ДАНИХ ═══');
  logger.info(`📊 Ринків: ${db_data.markets.length}`);
  logger.info(`🎲 Ставок: ${db_data.bets.length}`);
  logger.info(`👥 Гравців: ${db_data.users.length}`);

  logger.info('\n✅ Тестування завершено!');
}

test().catch(console.error);
