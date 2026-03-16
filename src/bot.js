// src/bot.js
// ════════════════════════════════════════
//  TELEGRAM BOT
//  Сповіщення, команди, взаємодія
// ════════════════════════════════════════

const { Telegraf, Markup } = require('telegraf');
const db     = require('./db');
const logger = require('./logger');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const ADMIN_ID = process.env.ADMIN_CHAT_ID;

// ── Команди ─────────────────────────────

bot.command('start', async (ctx) => {
  const user = db.getOrCreateUser(
    ctx.from.id,
    ctx.from.username || ctx.from.first_name
  );

  await ctx.reply(
    `🔮 *Ласкаво просимо до OracleX!*\n\n` +
    `Твій стартовий баланс: *${user.gems.toLocaleString()} 💎*\n\n` +
    `Передбачай події — виграй монети!\n` +
    `Відкрий міні-апп нижче 👇`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        [Markup.button.webApp('🔮 Відкрити OracleX', process.env.WEBAPP_URL || 'https://t.me/OracleXBot/app')],
      ]).resize(),
    }
  );
});

bot.command('balance', async (ctx) => {
  const user = db.getOrCreateUser(ctx.from.id, ctx.from.username);
  await ctx.reply(
    `💎 Твій баланс: *${user.gems.toLocaleString()} 💎*\n` +
    `🎯 Перемог: ${user.wins} | Поразок: ${user.losses}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('markets', async (ctx) => {
  const markets = db.getOpenMarkets().slice(0, 5);
  if (markets.length === 0) {
    return ctx.reply('Наразі немає відкритих ринків.');
  }

  let text = '📊 *Активні ринки:*\n\n';
  markets.forEach((m, i) => {
    const total = m.poolYes + m.poolNo;
    text += `${i+1}. ${m.icon} *${m.question}*\n`;
    text += `   💎 Пул: ${total.toLocaleString()} | ⏱ ${m.deadlineStr}\n\n`;
  });

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ── Адмін команди ───────────────────────

bot.command('pending', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;

  const db_data = db.load();
  const pending = db_data.markets.filter(m => m.status === 'pending_review');

  if (pending.length === 0) {
    return ctx.reply('✅ Немає ринків на перевірку');
  }

  for (const m of pending.slice(0, 5)) {
    await ctx.reply(
      `⚠️ *Ринок #${m.id} потребує рішення*\n\n` +
      `❓ ${m.question}\n` +
      `📝 ${m.sub || ''}\n` +
      `🔗 ${m.source || 'немає джерела'}\n\n` +
      `AI: ${m.resolveNote || 'немає пояснення'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ YES', `resolve_${m.id}_yes`),
            Markup.button.callback('❌ NO', `resolve_${m.id}_no`),
            Markup.button.callback('↩ Refund', `resolve_${m.id}_refund`),
          ],
        ]),
      }
    );
  }
});

// Адмін вирішує ринок вручну
bot.action(/resolve_(\d+)_(yes|no|refund)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('Немає прав');

  const marketId = parseInt(ctx.match[1]);
  const result   = ctx.match[2];
  const market   = db.getMarket(marketId);

  if (!market) return ctx.answerCbQuery('Ринок не знайдено');

  // Імпортуємо payoutWinners з oracle
  const { payoutWinners } = require('./oracle_helpers');

  let payoutInfo;
  if (result === 'refund') {
    // Повернення всім
    const bets = db.getBetsForMarket(marketId);
    bets.forEach(bet => db.addGems(bet.userId, bet.amount));
    db.updateMarket(marketId, {
      status: 'resolved', result: 'refund',
      resolvedAt: new Date().toISOString(),
      resolveNote: 'Вручну вирішено адміністратором: повернення',
    });
    payoutInfo = { type: 'refund' };
  } else {
    payoutInfo = payoutWinners(market, result);
    db.updateMarket(marketId, {
      resolveNote: `Вручну вирішено адміністратором: ${result.toUpperCase()}`,
    });
  }

  await ctx.editMessageText(
    `✅ Ринок #${marketId} вирішено: *${result.toUpperCase()}*\n` +
    `${payoutInfo.type === 'payout' ? `💰 Виплачено: ${payoutInfo.total?.toLocaleString()} 💎 (${payoutInfo.winners} переможців)` : '↩ Всім повернуто ставки'}`,
    { parse_mode: 'Markdown' }
  );

  await ctx.answerCbQuery('Вирішено!');

  // Сповіщаємо гравців
  await notifyMarketResolved(market, result, payoutInfo);
});

// ── Сповіщення ───────────────────────────

/**
 * Сповіщає адміна про нові ринки
 */
async function notifyAdminNewMarkets(markets) {
  if (!ADMIN_ID || markets.length === 0) return;

  let text = `🤖 *Згенеровано ${markets.length} нових ринків:*\n\n`;
  markets.slice(0, 5).forEach((m, i) => {
    text += `${i+1}. ${m.icon} ${m.question}\n`;
  });
  if (markets.length > 5) text += `...і ще ${markets.length - 5}`;

  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.warn('Не вдалось сповістити адміна:', err.message);
  }
}

/**
 * Сповіщає адміна про ринки що потребують перевірки
 */
async function notifyAdminPendingReview(market) {
  if (!ADMIN_ID) return;

  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `⚠️ *Ринок потребує рішення #${market.id}*\n\n` +
      `${market.question}\n\n` +
      `AI: ${market.resolveNote}\n\n` +
      `Введи /pending для перегляду`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.warn('Не вдалось сповістити адміна:', err.message);
  }
}

/**
 * Сповіщає про вирішення ринку (в загальний канал якщо є)
 */
async function notifyMarketResolved(market, result, payoutInfo) {
  if (!ADMIN_ID) return;

  const emoji = result === 'yes' ? '✅' : result === 'no' ? '❌' : '↩';
  const text =
    `${emoji} *Ринок вирішено!*\n\n` +
    `${market.icon} ${market.question}\n\n` +
    `Результат: *${result.toUpperCase()}*\n` +
    (payoutInfo.type === 'payout'
      ? `💰 Виплачено: ${payoutInfo.total?.toLocaleString()} 💎\n👥 Переможців: ${payoutInfo.winners}`
      : '↩ Ставки повернуто');

  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.warn('Помилка сповіщення:', err.message);
  }
}

module.exports = {
  bot,
  notifyAdminNewMarkets,
  notifyAdminPendingReview,
  notifyMarketResolved,
};
