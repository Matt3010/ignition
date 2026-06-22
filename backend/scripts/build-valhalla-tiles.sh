#!/usr/bin/env bash
set -euo pipefail

OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_HOST_DATA_DIR="${OSM_HOST_DATA_DIR:-}"
OSM_REGIONS="${OSM_REGIONS:-italy}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_BUILD_HOST_TILE_DIR="${VALHALLA_BUILD_HOST_TILE_DIR:-}"
VALHALLA_DOCKER_IMAGE="${VALHALLA_DOCKER_IMAGE:-ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1}"
VALHALLA_DOCKER_PLATFORM="${VALHALLA_DOCKER_PLATFORM:-linux/arm64/v8}"

absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"
VALHALLA_TILE_DIR_ABS="$(absolute_path "$VALHALLA_TILE_DIR")"
OSM_MOUNT_DIR_ABS="${OSM_HOST_DATA_DIR:-$OSM_DATA_DIR_ABS}"
VALHALLA_MOUNT_DIR_ABS="${VALHALLA_BUILD_HOST_TILE_DIR:-$VALHALLA_TILE_DIR_ABS}"
STATE_DIR="$VALHALLA_TILE_DIR_ABS/.build-state"
FINGERPRINT_FILE="$STATE_DIR/fingerprint"
BUILD_CONTAINER_NAME="ignition-valhalla-build-$$-$RANDOM"
BUILD_CONTAINER_RUNNING=false

IFS=',' read -r -a raw_regions <<< "$OSM_REGIONS"
inputs=()
input_metadata=()
for raw in "${raw_regions[@]}"; do
  region="$(trim "$raw")"; [[ -n "$region" ]] || continue
  pbf="$OSM_DATA_DIR/$region.osm.pbf"
  pbf_abs="$OSM_DATA_DIR_ABS/$region.osm.pbf"
  [[ -f "$pbf_abs" ]] || { echo "Missing $pbf. Run npm run osm:download first." >&2; exit 1; }
  inputs+=("/data/osm/$region.osm.pbf")
  input_metadata+=("$region:$(stat -c '%s:%Y' "$pbf_abs")")
done
[[ ${#inputs[@]} -gt 0 ]] || { echo "No OSM regions configured" >&2; exit 64; }

mkdir -p "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" "$STATE_DIR"
chmod 0777 "$VALHALLA_TILE_DIR_ABS" "$VALHALLA_TILE_DIR_ABS/valhalla_tiles"
cp docker/valhalla/valhalla.json "$VALHALLA_TILE_DIR_ABS/valhalla.json"

fingerprint_payload="$VALHALLA_DOCKER_IMAGE|$VALHALLA_DOCKER_PLATFORM|$(sha256sum docker/valhalla/valhalla.json | awk '{print $1}')|${input_metadata[*]}"
current_fingerprint="$(printf '%s' "$fingerprint_payload" | sha256sum | awk '{print $1}')"

clear_staging_for_new_inputs() {
  echo '{"event":"valhalla_build_staging_reset","reason":"inputs_changed"}' >&2
  find "$VALHALLA_TILE_DIR_ABS" -mindepth 1 -maxdepth 1 ! -name valhalla.json -exec rm -rf -- {} +
  mkdir -p "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" "$STATE_DIR"
}

if [[ -f "$FINGERPRINT_FILE" ]]; then
  previous_fingerprint="$(cat "$FINGERPRINT_FILE")"
  if [[ "$previous_fingerprint" != "$current_fingerprint" ]]; then
    clear_staging_for_new_inputs
  fi
fi
printf '%s\n' "$current_fingerprint" > "$FINGERPRINT_FILE.tmp"
mv "$FINGERPRINT_FILE.tmp" "$FINGERPRINT_FILE"

# Migration path for staging created by older project versions. Existing .gph
# files prove that parsing/edge construction already completed, so resume from
# the build stage instead of deleting several gigabytes of useful work.
if [[ ! -f "$STATE_DIR/constructedges.complete" ]] && \
   find "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" -type f -name '*.gph' -print -quit | grep -q .; then
  touch "$STATE_DIR/constructedges.complete"
  echo '{"event":"valhalla_build_legacy_progress_detected","resumeFrom":"build"}'
fi

stop_build_container() {
  if [[ "$BUILD_CONTAINER_RUNNING" == "true" ]]; then
    docker stop -t 30 "$BUILD_CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm -f "$BUILD_CONTAINER_NAME" >/dev/null 2>&1 || true
    BUILD_CONTAINER_RUNNING=false
  fi
}

on_interrupt() {
  echo '{"event":"valhalla_build_interrupted","progressPreserved":true}' >&2
  stop_build_container
  exit 143
}
trap on_interrupt INT TERM
trap stop_build_container EXIT

run_stage() {
  local start_stage="$1" end_stage="$2" marker="$3"
  echo "{\"event\":\"valhalla_build_stage_started\",\"start\":\"$start_stage\",\"end\":\"$end_stage\"}"
  BUILD_CONTAINER_RUNNING=true
  docker run --rm \
    --name "$BUILD_CONTAINER_NAME" \
    --platform "$VALHALLA_DOCKER_PLATFORM" \
    --entrypoint valhalla_build_tiles \
    -v "${OSM_MOUNT_DIR_ABS}:/data/osm" \
    -v "${VALHALLA_MOUNT_DIR_ABS}:/custom_files" \
    "$VALHALLA_DOCKER_IMAGE" \
    -c /custom_files/valhalla.json \
    -s "$start_stage" -e "$end_stage" \
    "${inputs[@]}"
  BUILD_CONTAINER_RUNNING=false
  touch "$STATE_DIR/$marker.tmp"
  mv "$STATE_DIR/$marker.tmp" "$STATE_DIR/$marker"
  echo "{\"event\":\"valhalla_build_stage_finished\",\"start\":\"$start_stage\",\"end\":\"$end_stage\"}"
}

if [[ ! -f "$STATE_DIR/constructedges.complete" ]]; then
  run_stage initialize constructedges constructedges.complete
fi

if [[ ! -f "$STATE_DIR/build.complete" ]]; then
  run_stage build build build.complete
fi

if [[ ! -f "$STATE_DIR/cleanup.complete" ]]; then
  run_stage enhance cleanup cleanup.complete
fi

if ! find "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" -type f -name '*.gph' -print -quit | grep -q .; then
  echo "Valhalla build completed without graph tiles" >&2
  exit 1
fi

echo '{"event":"valhalla_build_complete","progressPreserved":true}'
