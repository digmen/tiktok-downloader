import fs from 'node:fs/promises';

// Резолвер TikTok через бесплатный API tikwm.com. Используется как основной
// источник (даёт ВСЕ картинки слайдшоу и видео без водяного знака), а yt-dlp
// остаётся запасным вариантом на случай, если tikwm недоступен.

const API = 'https://tikwm.com/api/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Абсолютный URL: tikwm иногда отдаёт относительные пути.
function abs(u) {
  if (!u) return null;
  return u.startsWith('/') ? 'https://tikwm.com' + u : u;
}

/**
 * Запрашивает у tikwm данные поста. Бросает ошибку при любой неудаче —
 * вызывающий код тогда откатывается на yt-dlp.
 * @returns {Promise<
 *   | { type: 'photo', title?: string, imageUrls: string[], audioUrl: string|null }
 *   | { type: 'video', title?: string, videoUrl: string, audioUrl: string|null, duration?: number }
 * >}
 */
export async function resolveTikwm(url) {
  const res = await fetchWithTimeout(`${API}?hd=1&url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`tikwm HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(`tikwm code=${json.code} msg=${json.msg || ''}`);
  }
  const d = json.data;
  const title = (d.title || '').trim().slice(0, 200) || undefined;

  if (Array.isArray(d.images) && d.images.length) {
    return {
      type: 'photo',
      title,
      imageUrls: d.images.map(abs).filter(Boolean),
      audioUrl: abs(d.music),
    };
  }

  const videoUrl = abs(d.hdplay || d.play || d.wmplay);
  if (!videoUrl) throw new Error('tikwm: нет ссылки на видео');
  return { type: 'video', title, videoUrl, audioUrl: abs(d.music), duration: d.duration };
}

/**
 * Скачивает URL в файл. Проверяет размер (по Content-Length и по факту),
 * чтобы не тянуть в память гигантские файлы. Возвращает путь.
 */
export async function downloadUrlToFile(url, dest, maxBytes) {
  const res = await fetchWithTimeout(url, {}, 60_000);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`file too large (${declared} bytes)`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    throw new Error(`file too large (${buf.length} bytes)`);
  }
  await fs.writeFile(dest, buf);
  return dest;
}
