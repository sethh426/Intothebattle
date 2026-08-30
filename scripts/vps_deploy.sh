#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.production"
ENV_EXAMPLE="$ROOT/.env.production.example"
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"
  sed -i "s/^${key}=.*/${key}=${escaped}/" "$ENV_FILE"
}

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  set_env_value "POSTGRES_PASSWORD" "$(rand_hex)"
  set_env_value "JWT_SECRET" "$(rand_hex)"
  set_env_value "OVERLAY_TOKEN_SECRET" "$(rand_hex)"
  set_env_value "METRICS_TOKEN" "$(rand_hex)"
  set_env_value "DIAGNOSTICS_TOKEN" "$(rand_hex)"

  echo "Created $ENV_FILE with generated local secrets."
  echo "Edit it and copy production API/payment/email values before running deploy again."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker first, then rerun this script."
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
