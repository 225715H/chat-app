COMPOSE := docker compose

.PHONY: help up down restart logs ps build clean \
	app_start_dev app_stop_dev app_restart_dev app_logs_dev app_ps_dev \
	local_install local_build local_backend local_frontend

help:
	@echo "Targets:"
	@echo "  make app_start_dev   # docker compose up -d --build"
	@echo "  make app_stop_dev    # docker compose down -v (reset dev data)"
	@echo "  make app_restart_dev # docker compose restart"
	@echo "  make app_logs_dev    # docker compose logs -f --tail=150"
	@echo "  make app_ps_dev      # docker compose ps"
	@echo "  make build           # docker compose build"
	@echo "  make clean           # docker compose down -v"
	@echo "  make local_install # npm install in backend/frontend"
	@echo "  make local_build   # build backend/frontend"
	@echo "  make local_backend # run backend locally"
	@echo "  make local_frontend# run frontend locally"

app_start_dev:
	$(COMPOSE) up -d --build

app_stop_dev:
	$(COMPOSE) down -v

app_restart_dev:
	$(COMPOSE) restart

app_logs_dev:
	$(COMPOSE) logs -f --tail=150

app_ps_dev:
	$(COMPOSE) ps

up: app_start_dev

down: app_stop_dev

restart: app_restart_dev

logs: app_logs_dev

ps: app_ps_dev

build:
	$(COMPOSE) build

clean:
	$(COMPOSE) down -v

local_install:
	cd backend && npm install
	cd frontend && npm install

local_build:
	cd backend && npm run build
	cd frontend && npm run build

local_backend:
	cd backend && npm run start

local_frontend:
	cd frontend && npm run dev
