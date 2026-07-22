#!/bin/zsh
set -e
cd "$(dirname "$0")"

.venv/bin/python -m pytest
.venv/bin/ruff check src tests/python tools
node --check --input-type=commonjs < <(cat apps-script/SourceRegistry.gs apps-script/Code.gs)
node tests/apps_script_core.test.mjs
.venv/bin/python tests/source_registry_test.py
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].each { |file| YAML.load_file(file) }'

echo
echo "Все проверки пройдены."
read -r "?Нажмите Enter..."
