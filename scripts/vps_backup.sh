#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.production"
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U intothebattle intothebattle | gzip > "$BACKUP_DIR/postgres-$STAMP.sql.gz"

docker run --rm \
  -v intothebattle_app-data:/data:ro \
  -v "$BACKUP_DIR:/backup" \
  alpine:3.20 \
  tar -czf "/backup/app-data-$STAMP.tgz" -C /data .

find "$BACKUP_DIR" -type f \( -name 'postgres-*.sql.gz' -o -name 'app-data-*.tgz' \) -mtime +"$BACKUP_RETENTION_DAYS" -delete

echo "Wrote backups to $BACKUP_DIR"
