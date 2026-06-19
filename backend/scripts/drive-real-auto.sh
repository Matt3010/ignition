#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://road:road@127.0.0.1:5433/road_context}"
VALHALLA_BASE_URL="${VALHALLA_BASE_URL:-http://127.0.0.1:8002}"

docker compose -f docker-compose.yml up -d postgres valhalla

for _ in $(seq 1 30); do
  if curl -fsS "${VALHALLA_BASE_URL%/}/status" >/dev/null 2>&1; then
    exec env \
      DATABASE_URL="$DATABASE_URL" \
      VALHALLA_BASE_URL="$VALHALLA_BASE_URL" \
      npm run test:drive:real
  fi
  sleep 1
done

echo "Valhalla did not become ready at $VALHALLA_BASE_URL" >&2
exit 1
