#!/usr/bin/env bash
set -euo pipefail

DRIVE_CHUNK_START_LAT="${DRIVE_CHUNK_START_LAT:-45.000}"
DRIVE_CHUNK_START_LON="${DRIVE_CHUNK_START_LON:-11.000}"
DRIVE_CHUNK_STEP_LAT="${DRIVE_CHUNK_STEP_LAT:-0.006}"
DRIVE_CHUNK_STEP_LON="${DRIVE_CHUNK_STEP_LON:-0.000}"
DRIVE_CHUNK_HALF_LAT="${DRIVE_CHUNK_HALF_LAT:-0.010}"
DRIVE_CHUNK_HALF_LON="${DRIVE_CHUNK_HALF_LON:-0.010}"
DRIVE_CHUNK_MAX_CHUNKS="${DRIVE_CHUNK_MAX_CHUNKS:-}"
DRIVE_CHUNK_ITERATIONS="${DRIVE_CHUNK_ITERATIONS:-30}"
DRIVE_CHUNK_DELAY_MS="${DRIVE_CHUNK_DELAY_MS:-0}"
DRIVE_CHUNK_MIN_MATCH_RATE="${DRIVE_CHUNK_MIN_MATCH_RATE:-0}"
DRIVE_CHUNK_TILE_ROOT="${DRIVE_CHUNK_TILE_ROOT:-./data/valhalla-chunks}"
DRIVE_CHUNK_OSM_PREFIX="${DRIVE_CHUNK_OSM_PREFIX:-drive-chunk}"
DRIVE_CHUNK_DRY_RUN="${DRIVE_CHUNK_DRY_RUN:-false}"
DRIVE_CHUNK_PAUSE_SECONDS="${DRIVE_CHUNK_PAUSE_SECONDS:-10}"
DATABASE_URL="${DATABASE_URL:-postgres://road:road@127.0.0.1:5433/road_context}"
VALHALLA_BASE_URL="${VALHALLA_BASE_URL:-http://127.0.0.1:8002}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"

chunk_index=0
center_lat="$DRIVE_CHUNK_START_LAT"
center_lon="$DRIVE_CHUNK_START_LON"

echo_json() {
  printf '%s\n' "$1"
}

calc() {
  awk "BEGIN { printf \"%.6f\", $* }"
}

wait_valhalla() {
  for _ in $(seq 1 30); do
    if curl -fsS "${VALHALLA_BASE_URL%/}/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Valhalla did not become ready at $VALHALLA_BASE_URL" >&2
  return 1
}

while true; do
  if [[ -n "$DRIVE_CHUNK_MAX_CHUNKS" && "$chunk_index" -ge "$DRIVE_CHUNK_MAX_CHUNKS" ]]; then
    echo_json "{\"event\":\"drive_chunks_finished\",\"chunks\":$chunk_index}"
    exit 0
  fi

  region="${DRIVE_CHUNK_OSM_PREFIX}-${chunk_index}"
  tile_dir="${DRIVE_CHUNK_TILE_ROOT}/${region}"
  min_lon="$(calc "$center_lon - $DRIVE_CHUNK_HALF_LON")"
  min_lat="$(calc "$center_lat - $DRIVE_CHUNK_HALF_LAT")"
  max_lon="$(calc "$center_lon + $DRIVE_CHUNK_HALF_LON")"
  max_lat="$(calc "$center_lat + $DRIVE_CHUNK_HALF_LAT")"
  bbox="${min_lon},${min_lat},${max_lon},${max_lat}"

  echo_json "{\"event\":\"drive_chunk_prepare\",\"chunk\":$chunk_index,\"region\":\"$region\",\"bbox\":\"$bbox\",\"centerLat\":$center_lat,\"centerLon\":$center_lon}"

  if [[ "$DRIVE_CHUNK_DRY_RUN" != "true" ]]; then
    OSM_REGION="$region" OSM_BBOX="$bbox" npm run osm:bbox:direct
    OSM_REGION="$region" npm run import:osm-alerts
    rm -rf "$tile_dir"
    OSM_REGION="$region" VALHALLA_TILE_DIR="$tile_dir" npm run valhalla:build
    VALHALLA_TILE_DIR="$tile_dir" POSTGRES_PORT="$POSTGRES_PORT" docker compose -f docker-compose.yml up -d --force-recreate valhalla
    wait_valhalla

    DATABASE_URL="$DATABASE_URL" \
      VALHALLA_BASE_URL="$VALHALLA_BASE_URL" \
      DRIVE_SOAK_MAX_ITERATIONS="$DRIVE_CHUNK_ITERATIONS" \
      DRIVE_SOAK_DELAY_MS="$DRIVE_CHUNK_DELAY_MS" \
      DRIVE_SOAK_START_LAT="$center_lat" \
      DRIVE_SOAK_START_LON="$center_lon" \
      DRIVE_SOAK_MIN_LAT="$min_lat" \
      DRIVE_SOAK_MAX_LAT="$max_lat" \
      DRIVE_SOAK_MIN_LON="$min_lon" \
      DRIVE_SOAK_MAX_LON="$max_lon" \
      DRIVE_SOAK_MIN_MATCH_RATE="$DRIVE_CHUNK_MIN_MATCH_RATE" \
      npm run test:drive:real
  fi

  echo_json "{\"event\":\"drive_chunk_complete\",\"chunk\":$chunk_index,\"region\":\"$region\"}"
  chunk_index=$((chunk_index + 1))
  center_lat="$(calc "$center_lat + $DRIVE_CHUNK_STEP_LAT")"
  center_lon="$(calc "$center_lon + $DRIVE_CHUNK_STEP_LON")"
  if [[ -z "$DRIVE_CHUNK_MAX_CHUNKS" && "$DRIVE_CHUNK_PAUSE_SECONDS" != "0" ]]; then
    sleep "$DRIVE_CHUNK_PAUSE_SECONDS"
  fi
done
