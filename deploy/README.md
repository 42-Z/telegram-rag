# Развёртывание telegram-rag на VPS (Docker, Caddy)

Как у Mimic42: образ собирает GitHub Actions при каждом пуше в `main` и кладёт
в `ghcr.io/42-z/telegram-rag`, на сервере ничего не собирается. Системный
Caddy отдаёт домен наружу, приложение слушает только `127.0.0.1:8110`, база —
только внутренняя сеть compose, её данные — в томе `telegram-rag-db`.

## Первая настройка сервера (один раз)

```bash
DEPLOY=/root/sites/telegram-rag
mkdir -p "$DEPLOY" && cd "$DEPLOY"

# 1. Секреты — /etc/telegram-rag.env, права 600, в репозиторий не попадают.
#    TELEGRAM_SESSION — ОТДЕЛЬНАЯ сессия для сервера (npm run login ещё раз):
#    одна сессия в двух процессах сразу выбивает оба.
cat > /etc/telegram-rag.env <<'EOF'
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
TELEGRAM_CHANNELS=
OPENROUTER_API_KEY=
API_TOKEN=
ADMIN_TOKEN=
PUBLIC_URL=https://telegram-rag.zomb.top
EOF
chmod 600 /etc/telegram-rag.env

# 2. Переменные compose (не секреты).
cat > .env <<'EOF'
IMAGE_TAG=latest
APP_PORT=8110
EOF

# 3. Скопировать сюда deploy/docker-compose.yml и deploy/deploy.sh
#    (дальше каждая выкатка обновляет их сама через scp).

# 4. Домен в Caddy: дописать deploy/Caddyfile.snippet в /etc/caddy/Caddyfile.
#    Сначала проверить — ошибка в Caddyfile роняет все сайты сервера:
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

`DATABASE_URL` задаёт compose — в `/etc/telegram-rag.env` он не нужен.

## Репозиторий (один раз)

- Secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS` —
  те же, что у Mimic42, если сервер тот же.
- Variables: `DEPLOY_PATH=/root/sites/telegram-rag`, `DEPLOY_PORT=22`,
  `PUBLIC_URL=https://telegram-rag.zomb.top`.
- Environment `production`.
- После первой сборки пакет `ghcr.io/42-z/telegram-rag` переключить в PUBLIC.

## Как проходит выкатка

Пуш в `main` → проверки → сборка образа `ghcr.io/42-z/telegram-rag:sha-<sha>`
(+ `latest`) → scp compose и `deploy.sh` → `bash deploy.sh sha-<sha>`. Скрипт
ждёт здоровья контейнера 180 с и при неудаче сам откатывается на прежний тег.
Все теги — в `releases.log`; ручной откат — `bash deploy.sh <тег>`.

## Проверка после выкатки

```bash
curl -s https://telegram-rag.zomb.top/ | head -c 300                       # сводка адресов
curl -s https://telegram-rag.zomb.top/api/admin/channels -H "Authorization: Bearer $ADMIN_TOKEN"
docker compose logs --tail=100 app                                          # «вошли как …», «слежение за каналами: N»
```

## Неполадки

- `Telegram не запустился` в журнале — неверные `TELEGRAM_*` или сессия
  отозвана (Telegram → Настройки → Устройства). Новая: `npm run login`.
- `AUTH_KEY_DUPLICATED` — та же сессия запущена где-то ещё (локально?).
- Посты есть, `indexed` не растёт — ключ OpenRouter/баланс; ошибки видны в
  журнале `[indexer]`, после исправления — `POST /api/admin/retry-failed`.
- Резервная копия базы: `docker exec telegram-rag-db pg_dump -U telegram_rag telegram_rag > backup.sql`.
