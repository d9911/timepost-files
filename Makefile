SHELL := /bin/sh
COMPOSE ?= docker compose
.DEFAULT_GOAL := help
.PHONY: help setup start stop ps logs test lint smoke config
help:
	@printf '%s\n' 'make start — автономные API, PostgreSQL и worker; симулятор по умолчанию' 'make smoke — загрузка, чтение, пагинация и удаление своего тестового файла' 'make stop — остановка с сохранением томов' 'make test — тесты Node.js' 'make lint — проверка кода'
setup:
	@node scripts/init-env.mjs
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
	@$(COMPOSE) exec -T api node scripts/smoke.mjs
