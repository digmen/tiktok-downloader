import PQueue from 'p-queue';
import { config } from './config.js';
import { downloadTikTok } from './downloader.js';
import { UserFacingError } from './errors.js';

// Очередь загрузок с ограничением параллелизма и дедупликацией.
// Если один и тот же URL уже качается — новый запрос "подписывается" на
// тот же результат вместо запуска второй загрузки.

const queue = new PQueue({
  concurrency: config.queueConcurrency,
  // Небольшая пауза между стартами задач снижает риск rate-limit по IP.
  interval: 2000,
  intervalCap: 1,
});

/** @type {Map<string, Promise<any>>} in-flight загрузки по URL */
const inFlight = new Map();

// Специальная ошибка переполнения очереди.
export class QueueFullError extends UserFacingError {
  constructor() {
    super('🚦 Сервер сейчас загружен. Попробуйте, пожалуйста, через минуту.');
    this.name = 'QueueFullError';
  }
}

/**
 * Ставит загрузку URL в очередь и возвращает промис результата.
 * @param {string} url
 * @returns {Promise<{ filePath, jobDir, meta, title }>}
 */
export function enqueueDownload(url) {
  // Дедупликация: уже есть активная загрузка этого URL — переиспользуем.
  const existing = inFlight.get(url);
  if (existing) return existing;

  // Не считаем уже выполняющиеся (size — это ожидающие) — защита от завала.
  if (queue.size >= config.queueMaxSize) {
    return Promise.reject(new QueueFullError());
  }

  const task = queue
    .add(() => downloadTikTok(url))
    .finally(() => {
      inFlight.delete(url);
    });

  inFlight.set(url, task);
  return task;
}

// Позиция в очереди (для сообщения пользователю). Приблизительная.
export function queuePosition() {
  return queue.size + 1;
}

export function queueStats() {
  return { size: queue.size, pending: queue.pending };
}

// Ожидание завершения текущих задач при graceful shutdown.
export async function drainQueue(timeoutMs = 15000) {
  queue.pause();
  await Promise.race([
    queue.onIdle(),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}
