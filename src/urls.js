// Валидация и извлечение TikTok-ссылок из текста сообщения.

const MAX_URL_LENGTH = 500;

// Разрешённые хосты TikTok (с учётом www./m. и коротких доменов).
const ALLOWED_HOSTS = new Set([
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

// Достаём первый http(s)-URL из произвольного текста.
const URL_REGEX = /https?:\/\/[^\s]+/i;

/**
 * @param {string} text
 * @returns {{ ok: true, url: string } | { ok: false, reason: 'no_url' | 'bad_domain' | 'too_long' }}
 */
export function extractTikTokUrl(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, reason: 'no_url' };
  }

  const match = text.match(URL_REGEX);
  if (!match) {
    return { ok: false, reason: 'no_url' };
  }

  // Обрезаем возможные хвосты (кавычки, скобки, знаки препинания в конце).
  let raw = match[0].replace(/[)\]}>,.'"]+$/, '');

  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'no_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'no_url' };
  }

  const host = parsed.hostname.toLowerCase();
  const isAllowed = ALLOWED_HOSTS.has(host) || host.endsWith('.tiktok.com');
  if (!isAllowed) {
    return { ok: false, reason: 'bad_domain' };
  }

  // Возвращаем нормализованную ссылку (без лишних фрагментов).
  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}
