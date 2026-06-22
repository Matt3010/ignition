#!/usr/bin/env bash
set -euo pipefail

OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_HOST_DATA_DIR="${OSM_HOST_DATA_DIR:-}"
OSM_REGIONS="${OSM_REGIONS:-italy}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_BUILD_HOST_TILE_DIR="${VALHALLA_BUILD_HOST_TILE_DIR:-}"
absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"
VALHALLA_TILE_DIR_ABS="$(absolute_path "$VALHALLA_TILE_DIR")"
OSM_MOUNT_DIR_ABS="${OSM_HOST_DATA_DIR:-$OSM_DATA_DIR_ABS}"
VALHALLA_MOUNT_DIR_ABS="${VALHALLA_BUILD_HOST_TILE_DIR:-$VALHALLA_TILE_DIR_ABS}"
IFS=',' read -r -a raw_regions <<< "$OSM_REGIONS"
inputs=()
for raw in "${raw_regions[@]}"; do
  region="$(trim "$raw")"; [[ -n "$region" ]] || continue
  pbf="$OSM_DATA_DIR/$region.osm.pbf"
  [[ -f "$pbf" ]] || { echo "Missing $pbf. Run npm run osm:download first." >&2; exit 1; }
  inputs+=("/data/osm/$region.osm.pbf")
done
[[ ${#inputs[@]} -gt 0 ]] || { echo "No OSM regions configured" >&2; exit 64; }
mkdir -p "$VALHALLA_TILE_DIR_ABS/valhalla_tiles"
chmod 0777 "$VALHALLA_TILE_DIR_ABS" "$VALHALLA_TILE_DIR_ABS/valhalla_tiles"
cp docker/valhalla/valhalla.json "$VALHALLA_TILE_DIR_ABS/valhalla.json"
docker run --rm --platform "${VALHALLA_DOCKER_PLATFORM:-linux/arm64/v8}" \
  --entrypoint valhalla_build_tiles \
  -v "${OSM_MOUNT_DIR_ABS}:/data/osm" \
  -v "${VALHALLA_MOUNT_DIR_ABS}:/custom_files" \
  "${VALHALLA_DOCKER_IMAGE:-ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1}" \
  -c /custom_files/valhalla.json "${inputs[@]}"
