// Преобразование ошибок yt-dlp в понятные пользователю сообщения.
// Пользователь никогда не видит "кишки" stderr — только дружелюбный текст.

// Специальный класс ошибки, несущий готовое сообщение для пользователя.
export class UserFacingError extends Error {
  /**
   * @param {string} userMessage  текст для пользователя
   * @param {object} [opts]
   * @param {boolean} [opts.alertAdmin]  нужно ли уведомить админа (напр. rate-limit по IP)
   */
  constructor(userMessage, opts = {}) {
    super(userMessage);
    this.name = 'UserFacingError';
    this.userMessage = userMessage;
    this.alertAdmin = Boolean(opts.alertAdmin);
  }
}

// Набор правил: если stderr совпал с шаблоном — вернуть это сообщение.
const RULES = [
  {
    test: /private|only friends|login required|log in|sign in/i,
    message: '🔒 Видео приватное или требует входа в аккаунт — скачать не получится.',
  },
  {
    test: /video (is )?unavailable|not (be )?found|removed|deleted|does not exist|404/i,
    message: '❌ Видео недоступно или было удалено.',
  },
  {
    test: /geo|not available in your (country|region)|blocked in your/i,
    message: '🌍 Видео недоступно в регионе, где расположен сервер.',
  },
  {
    test: /file is larger than max-filesize|max-filesize|larger than/i,
    message: '📦 Видео больше 50 МБ — Telegram не даёт отправить такой файл.',
  },
  {
    // Признаки того, что TikTok ограничил загрузки с IP сервера.
    test: /captcha|rate.?limit|too many requests|429|unable to extract|no video formats|empty|slideshow post is not/i,
    message: '⏳ TikTok временно ограничил загрузки. Попробуйте через несколько минут.',
    alertAdmin: true,
  },
  {
    test: /photo mode|image post|slideshow|album/i,
    message: 'ℹ️ Это фото-пост (слайдшоу). Бот умеет скачивать только видео.',
  },
  {
    test: /Unsupported URL|is not a valid URL/i,
    message: '🤷 Не удалось распознать это как TikTok-видео.',
  },
];

/**
 * Возвращает UserFacingError на основе stderr yt-dlp.
 * @param {string} stderr
 * @returns {UserFacingError}
 */
export function mapYtDlpError(stderr) {
  const text = String(stderr || '');
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return new UserFacingError(rule.message, { alertAdmin: rule.alertAdmin });
    }
  }
  // Ничего не распознали — общее сообщение, детали остаются в логах.
  return new UserFacingError('😕 Не удалось скачать это видео. Попробуйте другую ссылку.');
}
