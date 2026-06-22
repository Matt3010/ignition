#!/usr/bin/env bash
set -euo pipefail

OSM_EXTRACT_PRESET="${OSM_EXTRACT_PRESET:-italy}"
OSM_EXTRACT_URL="${OSM_EXTRACT_URL:-}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_REGION="${OSM_REGION:-$OSM_EXTRACT_PRESET}"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"

preset_url() {
  case "$1" in
    italy) printf '%s\n' "https://download.geofabrik.de/europe/italy-latest.osm.pbf" ;;
    france) printf '%s\n' "https://download.geofabrik.de/europe/france-latest.osm.pbf" ;;
    germany) printf '%s\n' "https://download.geofabrik.de/europe/germany-latest.osm.pbf" ;;
    spain) printf '%s\n' "https://download.geofabrik.de/europe/spain-latest.osm.pbf" ;;
    switzerland) printf '%s\n' "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" ;;
    austria) printf '%s\n' "https://download.geofabrik.de/europe/austria-latest.osm.pbf" ;;
    slovenia) printf '%s\n' "https://download.geofabrik.de/europe/slovenia-latest.osm.pbf" ;;
    croatia) printf '%s\n' "https://download.geofabrik.de/europe/croatia-latest.osm.pbf" ;;
    *) return 1 ;;
  esac
}

if [[ -z "$OSM_EXTRACT_URL" ]]; then
  if ! OSM_EXTRACT_URL="$(preset_url "$OSM_EXTRACT_PRESET")"; then
    echo "Unknown OSM_EXTRACT_PRESET=$OSM_EXTRACT_PRESET. Set OSM_EXTRACT_URL to an explicit .osm.pbf extract URL." >&2
    exit 1
  fi
fi

mkdir -p "$OSM_DATA_DIR"
target="$OSM_DATA_DIR/$OSM_REGION.osm.pbf"
tmp_target="$OSM_DATA_DIR/$OSM_REGION.download.osm.pbf"
alerts_target="$OSM_DATA_DIR/$OSM_REGION.alerts.osm"
trap 'rm -f "$tmp_target"' EXIT

echo "Downloading OSM extract from $OSM_EXTRACT_URL"
echo "Target: $target"
curl -L --fail --retry 3 --retry-delay 2 --retry-all-errors --output "$tmp_target" "$OSM_EXTRACT_URL"
if command -v osmium >/dev/null 2>&1; then
  osmium fileinfo "$tmp_target" >/dev/null
else
  docker run --rm \
    -v "$OSM_DATA_DIR_ABS:/data" \
    "${OSMIUM_DOCKER_IMAGE:-ghcr.io/osmcode/osmium-tool:1.18.0}" \
    osmium fileinfo "/data/$OSM_REGION.download.osm.pbf" >/dev/null
fi
mv "$tmp_target" "$target"
echo "Done"

echo "Preparing lossless alert subset: $alerts_target"
filters=(
  n/highway=speed_camera w/highway=speed_camera
  n/speed_camera=yes w/speed_camera=yes
  n/camera:type=speed w/camera:type=speed
  n/enforcement w/enforcement r/enforcement
  nwr/traffic_signals=red_light_camera
  n/highway=construction w/highway=construction
  n/construction w/construction
  n/highway=roadworks w/highway=roadworks
  n/roadworks=yes w/roadworks=yes
  n/hazard w/hazard r/hazard
  n/hazard:conditional w/hazard:conditional r/hazard:conditional
  n/highway=hazard w/highway=hazard
)

# Include only lifecycle-prefixed forms of alert tags. Avoid filtering every
# disused/removed OSM object (buildings, shops, amenities, etc.).
for lifecycle in disused abandoned removed demolished razed; do
  filters+=(
    "nw/${lifecycle}:highway=speed_camera"
    "nw/${lifecycle}:speed_camera=yes"
    "nw/${lifecycle}:camera:type=speed"
    "nwr/${lifecycle}:enforcement"
    "nwr/${lifecycle}:traffic_signals=red_light_camera"
    "nw/${lifecycle}:highway=construction"
    "nw/${lifecycle}:construction"
    "nw/${lifecycle}:highway=roadworks"
    "nw/${lifecycle}:roadworks=yes"
    "nwr/${lifecycle}:hazard"
    "nwr/${lifecycle}:hazard:conditional"
    "nw/${lifecycle}:highway=hazard"
  )
done

if command -v osmium >/dev/null 2>&1; then
  osmium tags-filter "$target" "${filters[@]}" --overwrite --output "$alerts_target"
else
  echo "osmium not found locally; using Docker image ghcr.io/osmcode/osmium-tool" >&2
  docker run --rm \
    -v "$OSM_DATA_DIR_ABS:/data" \
    "${OSMIUM_DOCKER_IMAGE:-ghcr.io/osmcode/osmium-tool:1.18.0}" \
    osmium tags-filter "/data/$OSM_REGION.osm.pbf" \
      "${filters[@]}" \
      --overwrite --output "/data/$OSM_REGION.alerts.osm"
fi
echo "Done"
trap - EXIT
