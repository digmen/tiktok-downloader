import { config } from './config.js';

// Rate-limit на пользователя: не больше N загрузок в скользящем окне.
// Хранение in-memory (Map userId -> массив timestamp'ов). При рестарте
// сбрасывается — для бесплатного бота это приемлемо.

const windowMs = config.userLimitWindowMin * 60 * 1000;
/** @type {Map<number, number[]>} */
const hits = new Map();

/**
 * Проверяет, можно ли пользователю запустить ещё одну загрузку.
 * @param {number} userId
 * @returns {{ allowed: true } | { allowed: false, retryAfterMin: number }}
 */
export function checkUserLimit(userId) {
  // 0 или меньше в USER_LIMIT_COUNT = лимит выключен (бот личный, им пользуется владелец).
  if (config.userLimitCount <= 0) return { allowed: true };
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < windowMs);

  if (arr.length >= config.userLimitCount) {
    const oldest = arr[0];
    const retryAfterMin = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 60000));
    hits.set(userId, arr);
    return { allowed: false, retryAfterMin };
  }

  arr.push(now);
  hits.set(userId, arr);
  return { allowed: true };
}

// Возвращает последнюю запись назад, если загрузку так и не запустили
// (например, очередь оказалась переполнена) — чтобы попытка не «сгорала».
export function refundUserLimit(userId) {
  const arr = hits.get(userId);
  if (arr && arr.length > 0) {
    arr.pop();
    hits.set(userId, arr);
  }
}

// Периодическая очистка старых записей, чтобы Map не рос бесконечно.
export function startLimitsCleanup() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [userId, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length === 0) hits.delete(userId);
      else hits.set(userId, fresh);
    }
  }, windowMs);
  timer.unref?.();
  return timer;
}
