# Развёртывание telegram-rag на VPS (Docker, Caddy, облачная база)

Как у Mimic42: образ собирает GitHub Actions и кладёт в
`ghcr.io/42-z/telegram-rag`, на сервере ничего не собирается. Системный Caddy
отдаёт домен наружу, приложение слушает только `127.0.0.1:8110`. **Базы на
сервере нет** — это облачный Postgres с pgvector (Supabase или Neon), сервер
знает только строку подключения.

## База: Supabase или Neon

Подходит любой Postgres с расширением pgvector — схему сервис создаёт сам при
первом запуске (`CREATE EXTENSION vector`, таблицы, индексы). Нужно только
завести базу и взять строку подключения.

Сколько места нужно — замер на живых данных (400 постов, 283 куска с
векторами): куски с HNSW-индексом — 5 439 488 байт, посты с индексами —
1 196 032 байт, в среднем ≈ 16.6 КБ на пост, то есть 500 МБ ≈ 30 тысяч постов.
У каналов с длинными постами кусков на пост больше.

### Supabase — рекомендуется: команда им уже пользуется в Mimic42

Бесплатно: база 500 МБ, 2 активных проекта на организацию, проект засыпает
после недели бездействия (сервис пишет постоянно — это не про нас). Pro —
$25 в месяц, 8 ГБ включено ([supabase.com/pricing](https://supabase.com/pricing)).
Если оба бесплатных проекта организации уже заняты (например, Mimic42 prod и
dev) — нужен Pro или отдельная организация.

1. **New project**, регион поближе к VPS, пароль базы сохранить.
2. **Connect → Session pooler** — скопировать строку, подставить пароль,
   дописать `?sslmode=require`:
   `postgresql://postgres.<ref>:<пароль>@aws-0-<регион>.pooler.supabase.com:5432/postgres?sslmode=require`
   - Прямое подключение (`db.<ref>.supabase.co`) на бесплатном тарифе — только
     по IPv6, у VPS его может не быть.
   - Transaction pooler (порт 6543) не брать: сервис держит соединения
     постоянно и пользуется настройками сессии.
3. **Database Settings → SSL Configuration → Download certificate**: корневой
   сертификат у Supabase свой, без него проверка SSL не пройдёт. Как отдать его
   контейнеру — ниже, в первой настройке сервера.

### Neon

Бесплатно: 0.5 ГБ, 100 CU-часов вычислений в месяц, база засыпает после 5
минут простоя (отключить нельзя), кончились CU-часы — база выключена до
следующего месяца ([neon.com/pricing](https://neon.com/pricing),
[тарифы в документации](https://neon.com/docs/introduction/plans)).

**Бесплатного Neon сервису не хватит:** он следит за каналами постоянно, и база
почти не простаивает. Минимальная мощность — 0.25 CU; 0.25 × 24 ч × 30 дней =
180 CU-часов в месяц при лимите 100, база выключится примерно на 17-й день
(100 / (0.25 × 24) ≈ 16.7). На платном Launch — около 180 × $0.106 = $19.08 в
месяц за вычисления плюс $0.35 за ГБ хранения в месяц.

1. **New project**, регион поближе к VPS.
2. **Connect** — строка как есть (в ней уже `sslmode=require&channel_binding=require`).
   Сертификат у Neon публичный, `DATABASE_CA_CERT` не нужен.

## Первая настройка сервера (один раз)

```bash
DEPLOY=/root/sites/telegram-rag
mkdir -p "$DEPLOY" && cd "$DEPLOY"

# 1. Секреты — /etc/telegram-rag.env, права 600, в репозиторий не попадают.
#    TELEGRAM_SESSION — ОТДЕЛЬНАЯ сессия для сервера (npm run login ещё раз):
#    одна сессия в двух процессах сразу выбивает оба.
cat > /etc/telegram-rag.env <<'EOF'
DATABASE_URL=
DATABASE_CA_CERT=/run/secrets/db-ca.crt
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

Supabase: сертификат — в файл на сервере и в контейнер через
`docker-compose.override.yml` в той же папке (выкатка его не трогает, `deploy.sh`
подключает сам):

```bash
cp supabase-ca.crt /etc/telegram-rag-supabase-ca.crt && chmod 644 /etc/telegram-rag-supabase-ca.crt
cat > docker-compose.override.yml <<'EOF'
services:
  app:
    volumes:
      - /etc/telegram-rag-supabase-ca.crt:/run/secrets/db-ca.crt:ro
EOF
```

Neon: строку `DATABASE_CA_CERT` из секретов убрать, override не нужен.

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
- `не удалось подключиться к базе: …` — в журнале сразу сказано, что не так:
  IPv6 у прямого подключения Supabase, сертификат, пароль.
- Резервные копии — на стороне Supabase/Neon.
