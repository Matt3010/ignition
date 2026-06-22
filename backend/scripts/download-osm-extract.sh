#!/usr/bin/env bash
set -euo pipefail

OSM_REGIONS="${OSM_REGIONS:-italy}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"

absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
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

OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"
mkdir -p "$OSM_DATA_DIR"
IFS=',' read -r -a raw_regions <<< "$OSM_REGIONS"
regions=()
for raw in "${raw_regions[@]}"; do
  region="$(trim "$raw")"
  [[ -n "$region" ]] && regions+=("$region")
done
[[ ${#regions[@]} -gt 0 ]] || { echo "OSM_REGIONS does not contain any region" >&2; exit 64; }
filters=(
  n/highway=speed_camera w/highway=speed_camera n/speed_camera=yes w/speed_camera=yes
  n/camera:type=speed w/camera:type=speed n/enforcement w/enforcement r/enforcement
  nwr/traffic_signals=red_light_camera n/highway=construction w/highway=construction
  n/construction w/construction n/highway=roadworks w/highway=roadworks
  n/roadworks=yes w/roadworks=yes n/hazard w/hazard r/hazard
  n/hazard:conditional w/hazard:conditional r/hazard:conditional n/highway=hazard w/highway=hazard
)
for lifecycle in disused abandoned removed demolished razed; do
  filters+=(
    "nw/${lifecycle}:highway=speed_camera" "nw/${lifecycle}:speed_camera=yes"
    "nw/${lifecycle}:camera:type=speed" "nwr/${lifecycle}:enforcement"
    "nwr/${lifecycle}:traffic_signals=red_light_camera" "nw/${lifecycle}:highway=construction"
    "nw/${lifecycle}:construction" "nw/${lifecycle}:highway=roadworks"
    "nw/${lifecycle}:roadworks=yes" "nwr/${lifecycle}:hazard"
    "nwr/${lifecycle}:hazard:conditional" "nw/${lifecycle}:highway=hazard"
  )
done

for region in "${regions[@]}"; do
  if ! url="$(preset_url "$region")"; then
    echo "Unknown OSM region preset: $region. Supported presets: italy, france, germany, spain, switzerland, austria, slovenia, croatia." >&2
    exit 64
  fi
  target="$OSM_DATA_DIR/$region.osm.pbf"
  tmp_target="$OSM_DATA_DIR/$region.download.osm.pbf"
  alerts_target="$OSM_DATA_DIR/$region.alerts.osm"
  trap 'rm -f "$tmp_target"' EXIT
  echo "Downloading OSM extract for $region from $url"
  curl -L --fail --retry 3 --retry-delay 2 --retry-all-errors --output "$tmp_target" "$url"
  if command -v osmium >/dev/null 2>&1; then
    osmium fileinfo "$tmp_target" >/dev/null
  else
    docker run --rm -v "$OSM_DATA_DIR_ABS:/data" "${OSMIUM_DOCKER_IMAGE:-ghcr.io/osmcode/osmium-tool:1.18.0}" \
      osmium fileinfo "/data/$region.download.osm.pbf" >/dev/null
  fi
  mv "$tmp_target" "$target"
  if command -v osmium >/dev/null 2>&1; then
    osmium tags-filter "$target" "${filters[@]}" --overwrite --output "$alerts_target"
  else
    docker run --rm -v "$OSM_DATA_DIR_ABS:/data" "${OSMIUM_DOCKER_IMAGE:-ghcr.io/osmcode/osmium-tool:1.18.0}" \
      osmium tags-filter "/data/$region.osm.pbf" "${filters[@]}" --overwrite --output "/data/$region.alerts.osm"
  fi
  echo "Prepared $region"
  trap - EXIT
done
