#!/bin/zsh
set -e
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/sko-monitor" ]; then
  echo "Сначала запускаю установку..."
  zsh ./setup.command
fi

echo "Введите имя вашего СУЩЕСТВУЮЩЕГО аккаунта Instagram без @:"
read -r INSTAGRAM_USER
if [ -z "$INSTAGRAM_USER" ]; then
  echo "Имя не введено."
  exit 1
fi

mkdir -p data
.venv/bin/sko-monitor instagram-login \
  --username "$INSTAGRAM_USER" \
  --output data/instagram-session

chmod 600 data/instagram-session
base64 < data/instagram-session | tr -d '\n' > data/instagram-session.b64

echo
echo "Вход сохранён. Новый номер и новый аккаунт не требуются."

GH_BIN=""
if [ -x ".tools/gh" ]; then
  GH_BIN="$PWD/.tools/gh"
  export GH_CONFIG_DIR="$PWD/.tools/gh-config"
elif command -v gh >/dev/null 2>&1; then
  GH_BIN="$(command -v gh)"
fi

if [ -n "$GH_BIN" ]; then
  if "$GH_BIN" auth status >/dev/null 2>&1; then
    "$GH_BIN" secret set INSTAGRAM_USERNAME --repo misadtim-ctrl/sko-media-monitor --body "$INSTAGRAM_USER"
    "$GH_BIN" secret set INSTAGRAM_SESSION_B64 --repo misadtim-ctrl/sko-media-monitor < data/instagram-session.b64
    echo "Сессия защищённо загружена. Мониторинг Instagram можно включать."
  else
    echo "Сессия сохранена локально. GitHub пока не авторизован, поэтому секрет не загружен."
  fi
else
  echo "Сессия сохранена локально. GitHub CLI не найден, поэтому секрет не загружен."
fi
read -r "?Нажмите Enter..."
