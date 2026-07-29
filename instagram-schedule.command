#!/bin/zsh
# Включает и выключает автоматический сбор жалоб из Instagram на этом Mac.
# Двойной щелчок — включить; повторный щелчок покажет, что уже работает.
set -euo pipefail
cd "$(dirname "$0")"

PLIST_NAME="kz.sko.monitor.instagram"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
UID_NUM="$(id -u)"

pause_at_end() {
  echo
  print -n "Нажмите Enter, чтобы закрыть окно..."
  read -r
}
trap pause_at_end EXIT

if [ "${1:-}" = "off" ]; then
  launchctl bootout "gui/$UID_NUM/$PLIST_NAME" 2>/dev/null || true
  rm -f "$TARGET"
  echo "Сбор Instagram выключен."
  exit 0
fi

if [ ! -f "data/instagram-session" ]; then
  echo "Сначала запустите instagram-login.command — без сохранённого входа лента недоступна."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Нет файла .env с адресом моста. Скопируйте .env.example в .env и заполните."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" logs
cp "launchd/$PLIST_NAME.plist" "$TARGET"

# bootout перед bootstrap: иначе повторный запуск ругается «уже загружено».
launchctl bootout "gui/$UID_NUM/$PLIST_NAME" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$TARGET"
launchctl enable "gui/$UID_NUM/$PLIST_NAME"

echo "Готово. Городские паблики проверяются каждые 40 минут."
echo
echo "Проверить, что задача жива:   launchctl list | grep $PLIST_NAME"
echo "Посмотреть последний прогон:  tail -n 40 logs/instagram-feed.log"
echo "Выключить сбор:               ./instagram-schedule.command off"
echo
echo "Важно: пока Mac спит, сбор не идёт. Если он выключен дольше трёх часов,"
echo "Apps Script сам пришлёт предупреждение в Telegram."
