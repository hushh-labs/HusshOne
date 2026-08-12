.PHONY: install install-postgres test lint run demo legacy-demo compose-up compose-down

install:
	python -m pip install -e ".[dev]"

install-postgres:
	python -m pip install -e ".[dev,postgres]"

test:
	pytest -q

lint:
	ruff check app tests scripts

demo:
	python scripts/nws_demo.py

legacy-demo:
	python scripts/demo.py

run:
	uvicorn app.main:app --reload --port 8080

compose-up:
	docker compose up --build

compose-down:
	docker compose down
