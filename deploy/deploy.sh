#!/usr/bin/env bash
# Выкатка telegram-rag на VPS: deploy.sh <тег образа>. По образцу Mimic42.
#
# - Пишет IMAGE_TAG в .env (только переменные compose; секреты живут в
#   /etc/telegram-rag.env и здесь не трогаются).
# - Скачивает образ, пересоздаёт контейнеры, ждёт проверки здоровья (180 с).
# - При неудаче выводит журнал и сам откатывается на прежний тег.
# - Каждый тег дописывается в releases.log — по нему откатываются руками.
# - База — облачная (DATABASE_URL в /etc/telegram-rag.env), выкатка её не трогает.
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
COMPOSE="docker compose -f docker-compose.yml"
# Местные добавки сервера (сертификат базы и т. п.) — в override, его выкатка не трогает.
if [ -f docker-compose.override.yml ]; then
  COMPOSE="$COMPOSE -f docker-compose.override.yml"
fi
HEALTH_TIMEOUT=180

log() {
  echo "[deploy $(date -u +%FT%TZ)] $*"
}

previous_tag() {
  grep -E '^IMAGE_TAG=' .env 2>/dev/null | cut -d= -f2- || true
}

write_tag() {
  local tag="$1" tmp
  tmp="$(mktemp .env.XXXXXX)"
  grep -v -E '^IMAGE_TAG=' .env 2>/dev/null > "$tmp" || true
  printf 'IMAGE_TAG=%s\n' "$tag" >> "$tmp"
  mv "$tmp" .env
}

wait_healthy() {
  local elapsed=0 status
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' telegram-rag-app 2>/dev/null || true)"
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

rollout() {
  $COMPOSE pull app
  $COMPOSE up -d --remove-orphans
}

main() {
  cd "$(dirname "$0")"
  local prev
  prev="$(previous_tag)"

  log "deploying tag ${TAG} (previous: ${prev:-none})"
  echo "$(date -u +%FT%TZ) ${TAG}" >> releases.log

  write_tag "$TAG"
  rollout

  if wait_healthy; then
    log "healthy: app"
  else
    log "healthcheck FAILED after ${HEALTH_TIMEOUT}s, dumping logs"
    $COMPOSE logs --tail=100 app || true
    if [ -n "$prev" ] && [ "$prev" != "$TAG" ]; then
      log "ROLLBACK to ${prev}"
      write_tag "$prev"
      rollout
      if wait_healthy; then
        log "rollback to ${prev} healthy"
      else
        log "rollback to ${prev} NOT healthy, needs manual intervention"
      fi
    fi
    exit 1
  fi

  log "pruning our images older than 7 days (neighbors untouched)"
  docker image prune -a --force --filter "until=168h" --filter "reference=ghcr.io/42-z/telegram-rag" || true
  log "done"
}

main "$@"
