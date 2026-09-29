// Лог реальных скачиваний (кто/когда/успешно ли) — отдельно от access.js (там только
// кому ОТКРЫТ доступ). Без этого файла нельзя было сказать, сколько людей из allowed.json
// реально пользуется ботом, а сколько получили доступ и забыли (спросили 29.09).
// JSONL, не sqlite — бот личный, счёт на сотни строк в месяц, не нужна отдельная зависимость.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const DATA_DIR = path.resolve(config.tmpDir, '..', 'data');
const FILE = path.join(DATA_DIR, 'usage.jsonl');

// Одна строка на попытку скачивания. username — на момент события (может смениться,
// это снимок, не подписка на обновления).
export function logUsage({ userId, username, ok }) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const row = { ts: Date.now(), userId: String(userId), username: username || null, ok: Boolean(ok) };
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
  } catch (e) {
    // Лог не должен уронить сам download — если диск переполнен, это уже увидят
    // по hasEnoughDisk() в bot.js, здесь только не мешаем основному пути.
    console.error('[usage] Не удалось записать событие:', e.message);
  }
}

function readAll() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Сводка: всего событий, уникальных пользователей за всё время и за последние N дней.
export function usageStats() {
  const rows = readAll();
  const now = Date.now();
  const DAY = 86400000;

  const uniqueAllTime = new Set(rows.map((r) => r.userId));
  const within = (days) => {
    const cutoff = now - days * DAY;
    const recent = rows.filter((r) => r.ts >= cutoff);
    return { events: recent.length, users: new Set(recent.map((r) => r.userId)).size };
  };

  return {
    totalEvents: rows.length,
    ok: rows.filter((r) => r.ok).length,
    fail: rows.filter((r) => !r.ok).length,
    uniqueUsersAllTime: uniqueAllTime.size,
    last7d: within(7),
    last30d: within(30),
  };
}

// Список пользователей с числом скачиваний и датой последнего — кто реально живой,
// не только допущенный. Сортировка по последней активности, самые свежие сверху.
export function usersByActivity() {
  const rows = readAll();
  const byUser = new Map();
  for (const r of rows) {
    const u = byUser.get(r.userId) || { userId: r.userId, username: r.username, events: 0, ok: 0, lastTs: 0 };
    u.events++;
    if (r.ok) u.ok++;
    if (r.ts > u.lastTs) {
      u.lastTs = r.ts;
      u.username = r.username || u.username; // берём самый свежий известный username
    }
    byUser.set(r.userId, u);
  }
  return [...byUser.values()].sort((a, b) => b.lastTs - a.lastTs);
}
