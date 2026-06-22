#!/usr/bin/env bash
set -euo pipefail

OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_HOST_DATA_DIR="${OSM_HOST_DATA_DIR:-}"
OSM_REGION="${OSM_REGION:-italy}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_BUILD_HOST_TILE_DIR="${VALHALLA_BUILD_HOST_TILE_DIR:-}"
PBF="${OSM_DATA_DIR}/${OSM_REGION}.osm.pbf"
OSM_XML="${OSM_DATA_DIR}/${OSM_REGION}.osm"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"
VALHALLA_TILE_DIR_ABS="$(absolute_path "$VALHALLA_TILE_DIR")"
OSM_MOUNT_DIR_ABS="${OSM_HOST_DATA_DIR:-$OSM_DATA_DIR_ABS}"
VALHALLA_MOUNT_DIR_ABS="${VALHALLA_BUILD_HOST_TILE_DIR:-$VALHALLA_TILE_DIR_ABS}"

if [[ -f "$PBF" ]]; then
  OSM_INPUT="/data/osm/${OSM_REGION}.osm.pbf"
else
  echo "Missing $PBF. Valhalla build requires PBF input." >&2
  if [[ -f "$OSM_XML" ]]; then
    echo "Found XML at $OSM_XML, but it must be converted with osmium first." >&2
  fi
  echo "Run npm run osm:download before building Valhalla tiles." >&2
  exit 1
fi

mkdir -p "$VALHALLA_TILE_DIR_ABS/valhalla_tiles"
chmod 0777 "$VALHALLA_TILE_DIR_ABS" "$VALHALLA_TILE_DIR_ABS/valhalla_tiles"
cp docker/valhalla/valhalla.json "$VALHALLA_TILE_DIR_ABS/valhalla.json"
docker run --rm --platform linux/arm64/v8 \
  --entrypoint valhalla_build_tiles \
  -v "${OSM_MOUNT_DIR_ABS}:/data/osm" \
  -v "${VALHALLA_MOUNT_DIR_ABS}:/custom_files" \
  "${VALHALLA_DOCKER_IMAGE:-ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1}" \
  -c /custom_files/valhalla.json "$OSM_INPUT"
