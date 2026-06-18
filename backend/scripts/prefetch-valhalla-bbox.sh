#!/usr/bin/env bash
set -euo pipefail

OSM_REGION="${OSM_REGION:-prefetch}"
OSM_BBOX="${OSM_BBOX:-}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla-prefetch/$OSM_REGION}"
TILE_PREFETCH_RESTART_VALHALLA="${TILE_PREFETCH_RESTART_VALHALLA:-true}"
TILE_PREFETCH_FORCE="${TILE_PREFETCH_FORCE:-false}"
TILE_PREFETCH_DRY_RUN="${TILE_PREFETCH_DRY_RUN:-false}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

VALHALLA_TILE_DIR="$(absolute_path "$VALHALLA_TILE_DIR")"

if [[ -z "$OSM_BBOX" ]]; then
  echo "Set OSM_BBOX=minLon,minLat,maxLon,maxLat" >&2
  exit 1
fi

if [[ "$TILE_PREFETCH_DRY_RUN" == "true" ]]; then
  echo "{\"event\":\"tile_prefetch_dry_run\",\"region\":\"$OSM_REGION\",\"bbox\":\"$OSM_BBOX\",\"tileDir\":\"$VALHALLA_TILE_DIR\",\"restartValhalla\":$TILE_PREFETCH_RESTART_VALHALLA}"
  exit 0
fi

if [[ "$TILE_PREFETCH_FORCE" != "true" ]] && {
  [[ -f "$VALHALLA_TILE_DIR/valhalla_tiles/tile_manifest.json" ]] ||
    find "$VALHALLA_TILE_DIR/valhalla_tiles" -name '*.gph' -print -quit 2>/dev/null | grep -q .
}; then
  echo "{\"event\":\"tile_prefetch_skipped\",\"region\":\"$OSM_REGION\",\"reason\":\"already_built\"}"
  exit 0
fi

echo "{\"event\":\"tile_prefetch_started\",\"region\":\"$OSM_REGION\",\"bbox\":\"$OSM_BBOX\",\"tileDir\":\"$VALHALLA_TILE_DIR\"}"
OSM_REGION="$OSM_REGION" OSM_BBOX="$OSM_BBOX" npm run osm:bbox:direct
rm -rf "$VALHALLA_TILE_DIR"
OSM_REGION="$OSM_REGION" VALHALLA_TILE_DIR="$VALHALLA_TILE_DIR" npm run valhalla:build

if [[ "$TILE_PREFETCH_RESTART_VALHALLA" == "true" ]]; then
  VALHALLA_TILE_DIR="$VALHALLA_TILE_DIR" POSTGRES_PORT="$POSTGRES_PORT" docker compose -f docker-compose.yml up -d --force-recreate valhalla
fi

echo "{\"event\":\"tile_prefetch_finished\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$VALHALLA_TILE_DIR\",\"restartedValhalla\":$TILE_PREFETCH_RESTART_VALHALLA}"
