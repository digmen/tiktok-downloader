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

  // Убираем висящие апдейты, накопившиеся пока бот был выключен.
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => console.log(`[index] Бот @${info.username} запущен.`),
  });
}

main().catch((err) => {
  console.error('[index] Фатальная ошибка запуска:', err);
  process.exit(1);
});
