.PHONY: install test doctor main negative

install:
	python3 -m venv .venv
	.venv/bin/pip install -e '.[dev,instagram,media]'

test:
	.venv/bin/pytest
	.venv/bin/ruff check src tests/python tools

doctor:
	.venv/bin/sko-monitor doctor

main:
	.venv/bin/sko-monitor run --mode main --lookback-hours 72

negative:
	.venv/bin/sko-monitor run --mode negative --lookback-hours 72
