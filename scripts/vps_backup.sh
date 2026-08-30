#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.18.0}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_BACKUP="$BACKUP_DIR/postgres-$STAMP.dump"
DATA_BACKUP="$BACKUP_DIR/app-data-$STAMP.tgz"
CHECKSUM_FILE="$BACKUP_DIR/sha256-$STAMP.txt"

env_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing production environment: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U intothebattle -d intothebattle -Fc > "$DB_BACKUP"
test -s "$DB_BACKUP"

docker run --rm \
  -v intothebattle_app-data:/data:ro \
  -v "$BACKUP_DIR:/backup" \
  alpine:3.20 \
  tar -czf "/backup/$(basename "$DATA_BACKUP")" -C /data .
tar -tzf "$DATA_BACKUP" >/dev/null

(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$DB_BACKUP")" "$(basename "$DATA_BACKUP")" > "$(basename "$CHECKSUM_FILE")"
  sha256sum -c "$(basename "$CHECKSUM_FILE")" >/dev/null
)

restic_repository="$(env_value RESTIC_REPOSITORY)"
restic_password="$(env_value RESTIC_PASSWORD)"
offsite_required="$(env_value OFFSITE_BACKUP_REQUIRED)"

if [[ -n "$restic_repository" && -n "$restic_password" ]]; then
  restic() {
    docker run --rm \
      --env-file "$ENV_FILE" \
      -v "$BACKUP_DIR:/backup:ro" \
      "$RESTIC_IMAGE" "$@"
  }

  if ! restic snapshots --no-lock >/dev/null 2>&1; then
    echo "Initializing encrypted off-server backup repository..."
    restic init
  fi

  restic backup \
    "/backup/$(basename "$DB_BACKUP")" \
    "/backup/$(basename "$DATA_BACKUP")" \
    "/backup/$(basename "$CHECKSUM_FILE")" \
    --tag intothebattle-production
  restic forget --keep-daily 7 --keep-weekly 5 --keep-monthly 6 --prune
  echo "Encrypted off-server backup completed."
elif [[ "$offsite_required" == true ]]; then
  echo "OFFSITE_BACKUP_REQUIRED=true, but RESTIC_REPOSITORY or RESTIC_PASSWORD is missing." >&2
  exit 1
else
  echo "Warning: encrypted off-server backup is not configured; only the local backup was created." >&2
fi

find "$BACKUP_DIR" -type f \
  \( -name 'postgres-*.dump' -o -name 'app-data-*.tgz' -o -name 'sha256-*.txt' \) \
  -mtime +"$BACKUP_RETENTION_DAYS" -delete

echo "Verified local backup: $DB_BACKUP"
echo "Verified local backup: $DATA_BACKUP"
