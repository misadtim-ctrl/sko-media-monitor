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
echo "Файл для защищённого GitHub Secret подготовлен автоматически."
read -r "?Нажмите Enter..."
