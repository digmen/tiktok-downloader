#!/usr/bin/env bash
# Ежедневное самообновление yt-dlp. Ставится в cron (см. README).
# yt-dlp регулярно ломается из-за изменений TikTok — свежесть критична.
set -euo pipefail

YTDLP_BIN="${YTDLP_PATH:-/usr/local/bin/yt-dlp}"

echo "[$(date '+%F %T')] Обновление yt-dlp ($YTDLP_BIN)…"
"$YTDLP_BIN" -U || {
  echo "[$(date '+%F %T')] Обновление не удалось" >&2
  exit 1
}
echo "[$(date '+%F %T')] Готово. Версия: $("$YTDLP_BIN" --version)"
