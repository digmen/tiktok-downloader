import { bot } from './bot.js';
import { config } from './config.js';
import { cleanupOrphans } from './downloader.js';
import { startLimitsCleanup } from './limits.js';
import { drainQueue } from './queue.js';

// Глобальные страховки: бот не должен падать из-за необработанной ошибки.
process.on('unhandledRejection', (reason) => {
  console.error('[index] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[index] uncaughtException:', err);
});

async function main() {
  console.log('[index] Запуск TikTok-бота…');
  console.log(`[index] tmpDir=${config.tmpDir}, concurrency=${config.queueConcurrency}`);

  // Убираем мусор, оставшийся после прошлых запусков/падений.
  await cleanupOrphans();
  startLimitsCleanup();

  // Корректное завершение по сигналам от PM2/systemd.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[index] Получен ${signal}, завершаюсь…`);
    try {
      await bot.stop();            // перестаём принимать новые апдейты
      await drainQueue(15000);     // даём текущим загрузкам доработать
    } catch (e) {
      console.error('[index] Ошибка при завершении:', e.message);
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  startWatchdog();

  // Убираем висящие апдейты, накопившиеся пока бот был выключен.
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => console.log(`[index] Бот @${info.username} запущен.`),
  });
}

// Сторож: если у Telegram копятся непрочитанные сообщения, бот перестал их
// забирать (08.11.2026 так и было: процесс жив, а сообщения не читаются 4,5 дня).
// Три проверки подряд с непрочитанными (15 минут) — выходим, pm2 поднимет заново.
const WATCH_EVERY_MS = 5 * 60_000;
const WATCH_STRIKES = 3;
function startWatchdog() {
  let strikes = 0;
  setInterval(async () => {
    try {
      const info = await bot.api.getWebhookInfo();
      strikes = info.pending_update_count > 0 ? strikes + 1 : 0;
      if (strikes >= WATCH_STRIKES) {
        console.error(`[watchdog] ${info.pending_update_count} сообщений не забраны ${WATCH_STRIKES} проверки подряд — перезапуск`);
        process.exit(1);
      }
    } catch (e) {
      console.error('[watchdog] проверка не удалась:', e.message);
    }
  }, WATCH_EVERY_MS);
}

main().catch((err) => {
  console.error('[index] Фатальная ошибка запуска:', err);
  process.exit(1);
});
