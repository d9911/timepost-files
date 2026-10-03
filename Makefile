SHELL := /bin/sh
COMPOSE ?= docker compose
STANDALONE = node dist/scripts/standalone.js
.DEFAULT_GOAL := help
.PHONY: help setup start stop ps logs test lint smoke config test-db test-references build typecheck docs
help:
	@printf '%s\n' 'make start — автономные API, PostgreSQL и worker; симулятор по умолчанию' 'make smoke — загрузка, чтение, пагинация и удаление своего тестового файла' 'make stop — остановка с сохранением томов' 'make test — тесты Node.js' 'make lint — проверка кода' 'make build — сборка TypeScript' 'make typecheck — строгая проверка типов' 'make docs — HTML справочник API' 'make start-s3 — локальный S3 в том же Files на 3060' 'make smoke-s3 — фото, видео и удаление через S3-адаптер' 'make stop-s3 — остановка S3-стенда без удаления данных'
setup: build
	@node dist/scripts/init-env.js
config: setup
	@$(STANDALONE) config $(COMPOSE)
start: setup
	@$(STANDALONE) start $(COMPOSE)
stop: build
	@$(STANDALONE) stop $(COMPOSE)
ps: build
	@$(STANDALONE) ps $(COMPOSE)
logs: build
	@$(STANDALONE) logs $(COMPOSE)
test:
	@npm test
lint:
	@npm run lint
	@npm run format:check
smoke: build
	@$(STANDALONE) smoke $(COMPOSE)
test-db: build
	@$(STANDALONE) test-db $(COMPOSE)

node_modules/.package-lock.json: package.json package-lock.json
	@npm ci

build: node_modules/.package-lock.json
	@npm run build
typecheck:
	@npm run typecheck
docs:
	@npm run openapi:docs

test-references: build
	@$(STANDALONE) test-references $(COMPOSE)

.PHONY: icons
icons:
	@npm run icons:generate

.PHONY: setup-s3 start-s3 smoke-s3 stop-s3 logs-s3
setup-s3: setup
	@node dist/scripts/init-s3-env.js
start-s3: setup-s3
	@$(STANDALONE) start $(COMPOSE)
smoke-s3: smoke
stop-s3: stop
logs-s3: logs
