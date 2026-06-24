#!/usr/bin/env bash
set -euo pipefail

OSM_REGIONS="${OSM_REGIONS:-italy}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_DOWNLOAD_MIN_BYTES="${OSM_DOWNLOAD_MIN_BYTES:-1048576}"
OSM_ALERT_EXTRACT_MIN_BYTES="${OSM_ALERT_EXTRACT_MIN_BYTES:-1}"
OSM_REUSE_EXISTING_DOWNLOADS="${OSM_REUSE_EXISTING_DOWNLOADS:-false}"

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
    monaco) printf '%s\n' "https://download.geofabrik.de/europe/monaco-latest.osm.pbf" ;;
    *) return 1 ;;
  esac
}

OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"
mkdir -p "$OSM_DATA_DIR"

validate_osm_file() {
  local host_file="$1" container_file="$2" minimum_bytes="${3:-$OSM_DOWNLOAD_MIN_BYTES}"
  [[ -f "$host_file" ]] || return 1
  local bytes
  bytes="$(stat -c %s "$host_file" 2>/dev/null || printf '0')"
  (( bytes >= minimum_bytes )) || return 1
  if command -v osmium >/dev/null 2>&1; then
    osmium fileinfo "$host_file" >/dev/null 2>&1
  else
    docker run --rm -v "$OSM_DATA_DIR_ABS:/data" "${OSMIUM_DOCKER_IMAGE:-ghcr.io/osmcode/osmium-tool:1.18.0}" \
      osmium fileinfo "$container_file" >/dev/null 2>&1
  fi
}
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
    echo "Unknown OSM region preset: $region. Supported presets: italy, france, germany, spain, switzerland, austria, slovenia, croatia, monaco." >&2
    exit 64
  fi
  target="$OSM_DATA_DIR/$region.osm.pbf"
  tmp_target="$OSM_DATA_DIR/$region.download.osm.pbf"
  alerts_target="$OSM_DATA_DIR/$region.alerts.osm"
  reused_download=false
  if [[ "$OSM_REUSE_EXISTING_DOWNLOADS" == "true" ]] && validate_osm_file "$target" "/data/$region.osm.pbf"; then
    reused_download=true
    rm -f "$tmp_target"
    target_bytes="$(stat -c %s "$target")"
    echo "{\"event\":\"osm_download_reused\",\"region\":\"$region\",\"bytes\":$target_bytes}"
  else
    echo "Downloading OSM extract for $region from $url"
    if [[ -f "$tmp_target" ]]; then
      partial_bytes="$(stat -c %s "$tmp_target" 2>/dev/null || printf '0')"
      echo "Resuming partial download for $region from $partial_bytes bytes"
    fi

    # Geofabrik latest URLs may redirect. Keep the partial file on network or
    # process interruption so a later run can continue instead of restarting.
    curl \
      --fail \
      --location \
      --retry 5 \
      --retry-delay 5 \
      --retry-all-errors \
      --continue-at - \
      --output "$tmp_target" \
      "$url"

    downloaded_bytes="$(stat -c %s "$tmp_target" 2>/dev/null || printf '0')"
    if (( downloaded_bytes < OSM_DOWNLOAD_MIN_BYTES )); then
      echo "Downloaded OSM extract for $region is unexpectedly small: ${downloaded_bytes} bytes" >&2
      rm -f "$tmp_target"
      exit 65
    fi

    if ! validate_osm_file "$tmp_target" "/data/$region.download.osm.pbf"; then
      echo "Downloaded OSM extract for $region is not a valid OSM file" >&2
      rm -f "$tmp_target"
      exit 65
    fi
    echo "{\"event\":\"osm_download_completed\",\"region\":\"$region\",\"bytes\":$downloaded_bytes}"
    mv "$tmp_target" "$target"
    echo "{\"event\":\"osm_download_promoted\",\"region\":\"$region\",\"target\":\"$target\"}"
  fi

  reuse_alerts=false
  if [[ "$OSM_REUSE_EXISTING_DOWNLOADS" == "true" && -f "$alerts_target" && "$alerts_target" -nt "$target" ]] && \
    validate_osm_file "$alerts_target" "/data/$region.alerts.osm" "$OSM_ALERT_EXTRACT_MIN_BYTES"; then
    reuse_alerts=true
  fi

  if [[ "$reuse_alerts" == "true" ]]; then
    alerts_bytes="$(stat -c %s "$alerts_target")"
    echo "{\"event\":\"osm_alerts_reused\",\"region\":\"$region\",\"bytes\":$alerts_bytes}"
  else
    echo "{\"event\":\"osm_alert_extraction_started\",\"region\":\"$region\"}"
    if command -v osmium >/dev/null 2>&1; then
      osmium tags-filter "$target" "${filters[@]}" --overwrite --output "$alerts_target"
    else
      docker run --rm -v "$OSM_DATA_DIR_ABS:/data" "${OSMIUM_DOCKER_IMAGE:-ghcr.io/osmcode/osmium-tool:1.18.0}" \
        osmium tags-filter "/data/$region.osm.pbf" "${filters[@]}" --overwrite --output "/data/$region.alerts.osm"
    fi
    if ! validate_osm_file "$alerts_target" "/data/$region.alerts.osm" "$OSM_ALERT_EXTRACT_MIN_BYTES"; then
      echo "Prepared alert extract for $region is not a valid OSM file" >&2
      rm -f "$alerts_target"
      exit 65
    fi
    alerts_bytes="$(stat -c %s "$alerts_target")"
    echo "{\"event\":\"osm_alert_extraction_completed\",\"region\":\"$region\",\"bytes\":$alerts_bytes}"
  fi
  echo "{\"event\":\"osm_region_prepared\",\"region\":\"$region\",\"downloadReused\":$reused_download,\"alertsReused\":$reuse_alerts}"
done
