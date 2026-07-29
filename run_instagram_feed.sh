#!/bin/zsh
# Сбор жалоб из городских пабликов Instagram через ленту подписок.
# Запускается на этом Mac по расписанию launchd раз в 10 минут: Instagram
# пропускает жилой адрес и отвечает 429 облачным, поэтому в GitHub Actions
# этот контур работать не может — там остаются сайты, Telegram и YouTube.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p logs

# Вход в Instagram, сохранённый один раз через instagram-login.command.
export INSTAGRAM_USERNAME="${INSTAGRAM_USERNAME:-maxpipig}"
export INSTAGRAM_SESSION_FILE="data/instagram-session"

# Лента вместо обхода профилей: один запрос вместо двух десятков.
export INSTAGRAM_USE_FEED="true"
export INSTAGRAM_FEED_PAGES="5"
# Лента ранжированная и теоретически может пост не показать, поэтому за прогон
# дополнительно проверяем два профиля по очереди — весь список обходится за ~2 часа.
export INSTAGRAM_SWEEP_PROFILES="2"

export SOURCE_REGISTRY="config/sources.json"
export STATE_DB="data/instagram-feed.sqlite3"
export EXPORT_DIR="exports"
export ENABLE_DELIVERY="true"
export ENABLE_SEMANTIC="true"
export ENABLE_MEDIA_ANALYSIS="true"
# Жалоба часто приходит одним видео без подписи: кадры читает Vision из macOS.
export ENABLE_VIDEO_ANALYSIS="true"

# Адрес моста и секрет лежат в .env рядом с проектом — тот же файл, что и у
# ручных запусков. Telegram-токен здесь не нужен: публикацией занимается
# Apps Script, Python только передаёт находки через мост.
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Окно в три часа: если Mac спал, при пробуждении подхватываем пропущенное.
exec .venv/bin/sko-monitor run --mode negative --lookback-hours 3
