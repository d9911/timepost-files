SHELL := /bin/sh
COMPOSE ?= docker compose
STANDALONE = node dist/scripts/standalone.js
.DEFAULT_GOAL := help
.PHONY: help setup start stop ps logs test lint smoke config test-db test-references build typecheck docs
help:
	@printf '%s\n' 'make start — автономные API, PostgreSQL и worker; симулятор по умолчанию' 'make smoke — загрузка, чтение, пагинация и удаление своего тестового файла' 'make stop — остановка с сохранением томов' 'make test — тесты Node.js' 'make lint — проверка кода' 'make build — сборка TypeScript' 'make typecheck — строгая проверка типов' 'make docs — HTML справочник API' 'make start-s3 — собственный S3-сервер Files на 3062' 'make smoke-s3 — совместимость собственного S3 с обычным SDK (изолированные данные)' 'make stop-s3 — остановка S3-стенда без удаления данных'
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

NATIVE_S3_COMPOSE = $(COMPOSE) --env-file .env.native-s3 -f compose.native-s3.yaml
.PHONY: setup-s3 start-s3 stop-s3 logs-s3 config-s3 smoke-s3 setup-s3mock start-s3mock stop-s3mock smoke-s3mock logs-s3mock
setup-s3: build
	@node dist/scripts/init-native-s3-env.js
start-s3: setup-s3
	@$(NATIVE_S3_COMPOSE) up --detach --build --wait
stop-s3:
	@$(NATIVE_S3_COMPOSE) stop
logs-s3:
	@$(NATIVE_S3_COMPOSE) logs --tail 80 s3
config-s3: setup-s3
	@$(NATIVE_S3_COMPOSE) config --quiet
smoke-s3: build
	@node --test dist/test/s3-server-client.test.js
setup-s3mock: setup
	@node dist/scripts/init-s3-env.js
start-s3mock: setup-s3mock
	@$(STANDALONE) start $(COMPOSE)
stop-s3mock: stop
logs-s3mock: logs
smoke-s3mock: smoke
