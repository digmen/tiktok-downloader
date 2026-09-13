import fs from 'node:fs';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from './config.js';
import { extractTikTokUrl } from './urls.js';
import { checkUserLimit, refundUserLimit } from './limits.js';
import { enqueueDownload, queuePosition, queueStats } from './queue.js';
import { cleanupJob, hasEnoughDisk } from './downloader.js';
import { UserFacingError } from './errors.js';
import { addPending, approve, deny, isAllowed, isPending, listAllowed, revoke } from './access.js';

export const bot = new Bot(config.botToken, {
  client: config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : undefined,
});

// Автоповтор при 429 (Too Many Requests) и временных сбоях Telegram.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

// Доступ по запросу: чужой человек → карточка владельцу с кнопками, никто не заходит
// без явного «да» от него (см. access.js). Не открытая регистрация.
bot.use(async (ctx, next) => {
  const from = ctx.from;
  if (!from) return;
  if (isAllowed(from.id)) return next();
  if (ctx.callbackQuery) return next();

  if (isPending(from.id)) {
    await ctx.reply('⏳ Запрос уже отправлен автору бота — жди подтверждения.');
    return;
  }
  addPending(from.id, { username: from.username, firstName: from.first_name });
  await ctx.reply('📨 Запрос отправлен автору бота. Подтвердит — напишу тебе.');
  const who = from.username ? '@' + from.username : from.first_name || `id ${from.id}`;
  await bot.api
    .sendMessage(config.ownerId, `🆕 Хочет пользоваться TikTok-ботом: ${who} (id ${from.id})`, {
      reply_markup: new InlineKeyboard().text('✅ Разрешить', `allow:${from.id}`).text('🚫 Отклонить', `deny:${from.id}`),
    })
    .catch(() => {});
});

bot.callbackQuery(/^allow:(\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.answerCallbackQuery();
  const id = ctx.match[1];
  approve(id);
  await ctx.answerCallbackQuery({ text: 'Разрешено' });
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✅ Разрешено`).catch(() => {});
  await bot.api.sendMessage(id, '✅ Доступ открыт! Пришли ссылку на TikTok-видео.').catch(() => {});
});

bot.callbackQuery(/^deny:(\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.answerCallbackQuery();
  const id = ctx.match[1];
  deny(id);
  await ctx.answerCallbackQuery({ text: 'Отклонено' });
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🚫 Отклонено`).catch(() => {});
  await bot.api.sendMessage(id, '🚫 Доступ не дали.').catch(() => {});
});

bot.command('users', (ctx) => {
  if (String(ctx.from?.id) !== String(config.ownerId)) return;
  const list = listAllowed();
  ctx.reply(list.length ? '👥 Разрешены:\n' + list.join('\n') : 'Пока никого, кроме тебя.');
});
bot.command('revoke', (ctx) => {
  if (String(ctx.from?.id) !== String(config.ownerId)) return;
  const id = (ctx.match ?? '').trim();
  if (!id) return ctx.reply('/revoke <id>');
  revoke(id);
  ctx.reply(`Отозвано: ${id}`);
});

const WELCOME = [
  '👋 Привет!',
  'Я скачиваю видео из TikTok в лучшем качестве.',
  '',
  'Просто пришли мне ссылку на видео — и я верну его файлом.',
  '',
  'Поддерживаются ссылки вида tiktok.com/... и короткие vm.tiktok.com / vt.tiktok.com',
].join('\n');

// Уведомление админа (например, о признаках блокировки по IP).
async function alertAdmin(text) {
  if (!config.adminChatId) return;
  try {
    await bot.api.sendMessage(config.adminChatId, `⚠️ ${text}`);
  } catch (e) {
    console.error('[bot] Не удалось уведомить админа:', e.message);
  }
}

bot.command('start', (ctx) => ctx.reply(WELCOME));
bot.command('help', (ctx) => ctx.reply(WELCOME));

// --- Простая статистика (in-memory, сбрасывается при рестарте) ---
const startedAt = Date.now();
const stats = { ok: 0, fail: 0 };

function isAdmin(ctx) {
  return config.adminChatId && String(ctx.from?.id) === String(config.adminChatId);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? `${d}д` : '', h ? `${h}ч` : '', `${m}м`].filter(Boolean).join(' ');
}

// /ping — быстрая проверка, что бот жив (доступно всем).
bot.command('ping', (ctx) => ctx.reply('🏓 pong'));

// /stats — статистика сервера (только для админа).
bot.command('stats', (ctx) => {
  if (!isAdmin(ctx)) return; // молча игнорируем чужих
  const q = queueStats();
  const total = stats.ok + stats.fail;
  const text = [
    '📊 Статистика',
    `⏱ Аптайм: ${formatUptime(Date.now() - startedAt)}`,
    `✅ Успешно: ${stats.ok}`,
    `❌ С ошибкой: ${stats.fail}`,
    `📈 Всего запросов: ${total}`,
    `⏳ В очереди: ${q.size}, качается сейчас: ${q.pending}`,
  ].join('\n');
  return ctx.reply(text);
});

// Основной обработчик текстовых сообщений со ссылкой.
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const parsed = extractTikTokUrl(ctx.message.text);

  if (!parsed.ok) {
    const messages = {
      no_url: '🔗 Пришлите, пожалуйста, ссылку на видео из TikTok.',
      bad_domain: '🚫 Я умею скачивать только видео из TikTok. Пришлите ссылку tiktok.com',
      too_long: '🔗 Эта ссылка слишком длинная и выглядит некорректной.',
    };
    return ctx.reply(messages[parsed.reason] || messages.no_url);
  }

  // Проверка свободного места на диске.
  if (!(await hasEnoughDisk())) {
    await alertAdmin('Мало места на диске — загрузки приостановлены.');
    return ctx.reply('🚦 Сервер сейчас перегружен. Попробуйте немного позже.');
  }

  // Rate-limit на пользователя.
  const limit = checkUserLimit(userId);
  if (!limit.allowed) {
    return ctx.reply(
      `⏳ Вы достигли лимита загрузок. Попробуйте снова через ${limit.retryAfterMin} мин.`,
    );
  }

  let statusMsg;
  try {
    const position = queuePosition();
    const queueNote = position > 1 ? ` (в очереди: ${position})` : '';
    statusMsg = await ctx.reply(`⏳ Принял ссылку${queueNote}. Скачиваю…`);
  } catch (e) {
    console.error('[bot] Не удалось отправить статус:', e.message);
  }

  let job;
  try {
    job = await enqueueDownload(parsed.url);

    await editStatus(ctx, statusMsg, '📤 Загружаю в Telegram…');
    if (job.type === 'photo') await sendPhotoPost(ctx, job);
    else await sendVideoFile(ctx, job);
    await deleteStatus(ctx, statusMsg);
    stats.ok++;
  } catch (err) {
    stats.fail++;
    // Загрузка не состоялась — возвращаем «попытку» пользователю обратно.
    refundUserLimit(userId);

    if (err instanceof UserFacingError) {
      if (err.alertAdmin) await alertAdmin(`Проблема загрузки: ${err.userMessage}`);
      await editStatus(ctx, statusMsg, err.userMessage);
    } else {
      console.error('[bot] Непредвиденная ошибка:', err);
      await editStatus(ctx, statusMsg, '😕 Что-то пошло не так. Попробуйте ещё раз позже.');
    }
  } finally {
    if (job?.jobDir) await cleanupJob(job.jobDir);
  }
});

// Отправка видеофайла с корректными метаданными + звук отдельным сообщением.
async function sendVideoFile(ctx, job) {
  const { filePath, audioPath, meta, title } = job;
  const isMp4 = /\.mp4$/i.test(filePath);
  const caption = title ? title.slice(0, 1024) : undefined;
  const input = new InputFile(fs.createReadStream(filePath));

  if (isMp4) {
    await ctx.replyWithVideo(input, {
      caption,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      supports_streaming: true,
    });
  } else {
    // Нестандартный контейнер — отправляем документом, чтобы точно дошло.
    await ctx.replyWithDocument(input, { caption });
  }

  // Отдельным сообщением — звук из видео (как просили).
  if (audioPath) {
    try {
      await ctx.replyWithAudio(new InputFile(fs.createReadStream(audioPath)), {
        title,
        duration: meta.duration,
      });
    } catch (e) {
      console.error('[bot] Не удалось отправить звук из видео:', e.message);
    }
  }
}

// Отправка фото-поста TikTok: все картинки слайдшоу (альбомом) + звук (mp3).
async function sendPhotoPost(ctx, job) {
  const { audioPath, images = [], title } = job;
  const caption = title ? title.slice(0, 1024) : undefined;

  try {
    if (images.length === 1) {
      await ctx.replyWithPhoto(new InputFile(images[0]), { caption });
    } else if (images.length > 1) {
      // Telegram альбом — до 10 фото за раз, поэтому бьём на пачки.
      for (let i = 0; i < images.length; i += 10) {
        const chunk = images.slice(i, i + 10);
        const media = chunk.map((p, idx) =>
          InputMediaBuilder.photo(new InputFile(p), i === 0 && idx === 0 ? { caption } : {}),
        );
        await ctx.replyWithMediaGroup(media);
      }
    }
  } catch (e) {
    console.error('[bot] Не удалось отправить картинки:', e.message);
  }

  // Звук поста — отдельным сообщением.
  if (audioPath) {
    try {
      await ctx.replyWithAudio(new InputFile(audioPath), { title });
    } catch (e) {
      console.error('[bot] Не удалось отправить звук:', e.message);
    }
  }
}

async function editStatus(ctx, statusMsg, text) {
  if (!statusMsg) {
    try {
      await ctx.reply(text);
    } catch { }
    return;
  }
  try {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text);
  } catch {
    // Сообщение могло быть удалено/не изменилось — не критично.
  }
}

async function deleteStatus(ctx, statusMsg) {
  if (!statusMsg) return;
  try {
    await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
  } catch { }
}

// Глобальный перехватчик ошибок grammY — бот не должен падать.
bot.catch((err) => {
  console.error('[bot] Ошибка в обработчике:', err.error || err);
});
