// Вход через подписку на канал владельца: «все, кто пользуется моими ботами, подписаны
// на @DigmenDevLogs» (его просьба 23.10). Тот же принцип, что в станке и в нарезчике видео:
//  - проверка — getChatMember, Telegram отдаёт её только АДМИНАМ канала, поэтому бот должен быть
//    в канале админом (без прав). Пока это не так — «не знаю», и человека НЕ блокируем: наша
//    недонастройка не должна стоить пользователя; владельцу раз в сутки пишем, что делать;
//  - прошёл подписку однажды — больше не спрашиваем (вход, а не надзор), запоминаем на диске;
//  - владельца бота не проверяем.
import fs from 'node:fs';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';

const DATA_DIR = path.resolve(config.tmpDir, '..', 'data');
const FILE = path.join(DATA_DIR, 'subscribed.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}
const passed = load();

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...passed]));
  } catch {
    /* не критично: человека просто попросят подтвердить ещё раз после рестарта */
  }
}

/** Статус участника канала → подписан ли. Чистая функция — под тесты. */
export function isMemberStatus(status, isMember) {
  if (status === 'creator' || status === 'administrator' || status === 'member') return true;
  if (status === 'restricted') return isMember === true;
  return false; // left, kicked
}

export async function checkSubscribed(api, userId) {
  try {
    const m = await api.getChatMember(config.channel, userId);
    return isMemberStatus(m.status, m.is_member) ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

export const hasPassed = (id) => passed.has(String(id));
export function markPassed(id) {
  if (passed.has(String(id))) return;
  passed.add(String(id));
  persist();
}

export const channelUrl = () => 'https://t.me/' + config.channel.replace(/^@/, '');

export const SUBSCRIBE_TEXT = (channel) =>
  `📢 Чтобы пользоваться ботом, подпишись на канал ${channel}.\n\n` +
  'Там я пишу про свои проекты и когда что-то обновляется или ломается. Подписался — жми «Я подписался».';

const subscribeKb = () =>
  new InlineKeyboard().url('📢 Подписаться', channelUrl()).row().text('✅ Я подписался', 'subcheck');

/**
 * Ставит вход через подписку на бота. Вызывать ДО проверки доступа (access.js): неподписанному
 * не нужно слать владельцу карточку «хочет пользоваться».
 */
export function subscriptionGate(bot) {
  if (!config.channel) return; // CHANNEL пуст — вход выключен
  let alertAt = 0;

  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return next();
    if (String(from.id) === String(config.ownerId) || hasPassed(from.id)) return next();
    if (ctx.callbackQuery?.data === 'subcheck') return next();

    const st = await checkSubscribed(ctx.api, from.id);
    if (st === 'yes') {
      markPassed(from.id);
      return next();
    }
    if (st === 'unknown') {
      // Бот не админ канала — проверить нельзя. Не блокируем, но владельцу говорим (раз в сутки).
      if (Date.now() - alertAt > 24 * 3600_000) {
        alertAt = Date.now();
        await ctx.api
          .sendMessage(
            config.ownerId,
            `📢 Не могу проверить подписку на ${config.channel}: бот не админ канала. Добавь @${ctx.me.username} ` +
              'в администраторы канала (права не нужны) — пока пускаю всех без проверки.',
          )
          .catch(() => {});
      }
      return next();
    }
    // Не подписан.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Сначала подпишись на канал' }).catch(() => {});
    await ctx.reply(SUBSCRIBE_TEXT(config.channel), { reply_markup: subscribeKb() });
  });

  bot.callbackQuery('subcheck', async (ctx) => {
    const st = await checkSubscribed(ctx.api, ctx.from.id);
    if (st === 'no') {
      await ctx.answerCallbackQuery({ text: 'Пока не вижу подписки. Подпишись и нажми ещё раз.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    markPassed(ctx.from.id);
    await ctx.reply('Готово ✅ Напиши /start.');
  });
}
