import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { mapYtDlpError, UserFacingError } from './errors.js';

// Промис-обёртка над execFile. Никогда не используем shell — только массив
// аргументов, что исключает инъекцию команд через содержимое URL.
function run(bin, args, { timeoutMs, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: stdout || '',
          stderr: stderr || '',
          killed: Boolean(error && error.killed),
        });
      },
    );
  });
}

// Ищем в папке задачи первый файл, чьё имя подходит под расширение.
async function findFile(jobDir, extRegex) {
  const entries = await fs.readdir(jobDir);
  const found = entries.find((f) => extRegex.test(f));
  return found ? path.join(jobDir, found) : null;
}

// Достаём метаданные видео через ffprobe (для красивой отправки).
async function probeVideo(filePath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height:format=duration',
    '-of', 'json',
    filePath,
  ];
  const { error, stdout } = await run(config.ffprobePath, args, { timeoutMs: 30_000 });
  if (error) return {};
  try {
    const data = JSON.parse(stdout);
    const streams = data.streams || [];
    const video = streams.find((s) => s.codec_type === 'video') || {};
    const hasAudio = streams.some((s) => s.codec_type === 'audio');
    const duration = data.format?.duration ? Math.round(Number(data.format.duration)) : undefined;
    return {
      width: video.width || undefined,
      height: video.height || undefined,
      duration: Number.isFinite(duration) ? duration : undefined,
      hasAudio,
    };
  } catch {
    return {};
  }
}

// Фото-пост TikTok (слайдшоу): URL вида /photo/. yt-dlp не понимает /photo/,
// но прекрасно извлекает тот же пост по /video/. Из фото-поста реально
// доступны звук (mp3) и обложка — их и отдаём.
function isPhotoPost(url) {
  return /\/photo\//i.test(url);
}

/**
 * Скачивает один TikTok-пост (видео или фото-слайдшоу).
 * @param {string} url  уже провалидированная ссылка
 * @returns {Promise<
 *   | { type: 'video', filePath: string, jobDir: string, meta: object, title?: string }
 *   | { type: 'photo', audioPath: string, imagePath?: string, jobDir: string, title?: string }
 * >}
 * @throws {UserFacingError}
 */
export async function downloadTikTok(url) {
  const jobId = randomUUID();
  const jobDir = path.join(config.tmpDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const photo = isPhotoPost(url);
  const ytUrl = photo ? url.replace(/\/photo\//i, '/video/') : url;
  const outputTemplate = path.join(jobDir, 'media.%(ext)s');

  // Общие флаги. --write-info-json даёт заголовок в UTF-8 (иначе на Windows
  // yt-dlp печатает его в кодировке системы и текст ломается).
  const common = [
    '--max-filesize', `${config.maxFilesizeMb}M`,
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', '30',
    '--retries', '3',
    '-o', outputTemplate,
    '--write-info-json',
  ];

  const args = photo
    ? [
        // Фото-пост: качаем звук + обложку (в jpg, чтобы Telegram принял как фото).
        '-f', 'ba/b',
        '--write-thumbnail',
        '--convert-thumbnails', 'jpg',
        ...common,
        '--', ytUrl,
      ]
    : [
        // Видео: сначала пытаемся склеить лучшее видео+звук; если раздельного
        // звука нет — берём лучший ОДИНОЧНЫЙ формат, В КОТОРОМ ЕСТЬ звук
        // (b[acodec!=none]); и только в самом крайнем случае — любой (немой).
        // Иначе -S res мог выбрать топовый формат без звуковой дорожки.
        '-f', 'bv*+ba/b[acodec!=none]/b',
        '-S', 'res',
        '--merge-output-format', 'mp4',
        ...common,
        '--', ytUrl,
      ];

  const { error, stderr } = await run(config.ytdlpPath, args, {
    timeoutMs: config.downloadTimeoutSec * 1000,
  });

  if (error) {
    await cleanupJob(jobDir);
    if (error.killed || error.signal === 'SIGTERM') {
      throw new UserFacingError('⏱️ Скачивание заняло слишком много времени и было прервано.');
    }
    if (error.code === 'ENOENT') {
      // Бинарник yt-dlp не найден — это ошибка конфигурации сервера, не пользователя.
      console.error('[downloader] yt-dlp не найден по пути:', config.ytdlpPath);
      throw new UserFacingError('🔧 Технические неполадки на сервере. Попробуйте позже.', {
        alertAdmin: true,
      });
    }
    // Любая другая ошибка — разбираем stderr и отдаём человеческое сообщение.
    console.error('[downloader] yt-dlp stderr:', stderr.slice(0, 2000));
    throw mapYtDlpError(stderr);
  }

  const title = await readTitleFromInfoJson(jobDir);

  if (photo) {
    const audioPath = await findFile(jobDir, /\.(mp3|m4a|aac|opus|ogg|wav)$/i);
    if (!audioPath) {
      await cleanupJob(jobDir);
      console.error('[downloader] Звук фото-поста не найден. stderr:', stderr.slice(0, 1000));
      throw mapYtDlpError(stderr || 'no audio formats');
    }
    const imagePath = await findFile(jobDir, /\.(jpg|jpeg|png|webp)$/i);
    return { type: 'photo', audioPath, imagePath, jobDir, title };
  }

  const filePath = await findFile(jobDir, /\.(mp4|mov|webm|mkv)$/i);
  if (!filePath) {
    await cleanupJob(jobDir);
    console.error('[downloader] Файл не найден после загрузки. stderr:', stderr.slice(0, 1000));
    throw mapYtDlpError(stderr || 'no video formats');
  }

  const meta = await probeVideo(filePath);
  // Отдельно вытаскиваем звук из видео в mp3, чтобы прислать его отдельным
  // сообщением. Извлекаем только если звуковая дорожка реально есть.
  const audioPath = meta.hasAudio ? await extractAudioMp3(filePath, jobDir) : null;
  return { type: 'video', filePath, audioPath, jobDir, meta, title };
}

// Извлекает звук из видео в mp3 (перекодирование, качество ~190 kbps VBR).
// Возвращает путь или null при неудаче.
async function extractAudioMp3(videoPath, jobDir) {
  const audioPath = path.join(jobDir, 'audio.mp3');
  const args = ['-y', '-i', videoPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', audioPath];
  const { error } = await run(config.ffmpegPath, args, { timeoutMs: 120_000 });
  if (error) {
    console.error('[downloader] Не удалось извлечь звук:', error.message);
    return null;
  }
  return audioPath;
}

// Читает заголовок из media.info.json (UTF-8). Если файла нет или он битый —
// возвращает undefined (подпись просто не добавится).
async function readTitleFromInfoJson(jobDir) {
  try {
    const infoPath = path.join(jobDir, 'media.info.json');
    const raw = await fs.readFile(infoPath, 'utf8');
    const info = JSON.parse(raw);
    const title = (info.title || info.fulltitle || info.description || '').trim();
    return title ? title.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

// Рекурсивно удаляет папку задачи. Безопасно вызывать всегда (в т.ч. в finally).
export async function cleanupJob(jobDir) {
  if (!jobDir) return;
  try {
    await fs.rm(jobDir, { recursive: true, force: true });
  } catch (e) {
    console.error('[downloader] Не удалось удалить', jobDir, e.message);
  }
}

// Проверка свободного места на диске. Возвращает true, если места достаточно.
export async function hasEnoughDisk() {
  try {
    const stats = await fs.statfs(config.tmpDir);
    const freeMb = (stats.bsize * stats.bavail) / (1024 * 1024);
    return freeMb >= config.minFreeDiskMb;
  } catch (e) {
    // Если проверка недоступна (напр. старая ОС) — не блокируем работу.
    console.error('[downloader] statfs недоступен:', e.message);
    return true;
  }
}

// Зачистка осиротевших папок в tmp (вызывается при старте бота).
export async function cleanupOrphans() {
  try {
    await fs.mkdir(config.tmpDir, { recursive: true });
    const entries = await fs.readdir(config.tmpDir, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await cleanupJob(path.join(config.tmpDir, entry.name));
        removed++;
      }
    }
    if (removed > 0) console.log(`[downloader] Очищено осиротевших папок: ${removed}`);
  } catch (e) {
    console.error('[downloader] Ошибка очистки tmp:', e.message);
  }
}
