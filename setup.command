#!/bin/zsh
set -e
cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"
if [ ! -x ".venv/bin/python" ]; then
  "$PYTHON_BIN" -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e '.[dev,instagram,media]'
.venv/bin/sko-monitor doctor

echo
echo "Установка завершена. Это окно можно закрыть."
read -r "?Нажмите Enter..."
