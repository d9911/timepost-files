SHELL := /bin/sh
COMPOSE ?= docker compose
.DEFAULT_GOAL := help
.PHONY: help setup start stop ps logs test lint smoke config test-db build typecheck docs
help:
	@printf '%s\n' 'make start — автономные API, PostgreSQL и worker; симулятор по умолчанию' 'make smoke — загрузка, чтение, пагинация и удаление своего тестового файла' 'make stop — остановка с сохранением томов' 'make test — тесты Node.js' 'make lint — проверка кода' 'make build — сборка TypeScript' 'make typecheck — строгая проверка типов' 'make docs — HTML справочник API'
setup: build
	@node dist/scripts/init-env.js
config: setup
	@$(COMPOSE) config --quiet
start: setup
	@$(COMPOSE) up --detach --build --wait
stop:
	@$(COMPOSE) stop
ps:
	@$(COMPOSE) ps
logs:
	@$(COMPOSE) logs --tail 80 api worker
test:
	@npm test
lint:
	@npm run lint
	@npm run format:check
smoke:
	@$(COMPOSE) exec -T api node dist/scripts/smoke.js
test-db:
	@$(COMPOSE) exec -T api node dist/scripts/database-check.js

node_modules/.package-lock.json: package.json package-lock.json
	@npm ci

build: node_modules/.package-lock.json
	@npm run build
typecheck:
	@npm run typecheck
docs:
	@npm run openapi:docs
