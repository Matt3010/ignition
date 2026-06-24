#!/usr/bin/env bash
set -euo pipefail

OSM_REGIONS="${OSM_REGIONS:-italy}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_DOWNLOAD_MIN_BYTES="${OSM_DOWNLOAD_MIN_BYTES:-1048576}"
OSM_ALERT_EXTRACT_MIN_BYTES="${OSM_ALERT_EXTRACT_MIN_BYTES:-1}"
OSM_REUSE_EXISTING_DOWNLOADS="${OSM_REUSE_EXISTING_DOWNLOADS:-false}"
OSM_DOWNLOAD_RETRIES="${OSM_DOWNLOAD_RETRIES:-2}"
OSM_DOWNLOAD_RETRY_DELAY_SECONDS="${OSM_DOWNLOAD_RETRY_DELAY_SECONDS:-5}"
OSM_DOWNLOAD_CONNECT_TIMEOUT_SECONDS="${OSM_DOWNLOAD_CONNECT_TIMEOUT_SECONDS:-15}"
OSM_DOWNLOAD_MAX_TIME_SECONDS="${OSM_DOWNLOAD_MAX_TIME_SECONDS:-90}"
OSM_DOWNLOAD_SPEED_TIME_SECONDS="${OSM_DOWNLOAD_SPEED_TIME_SECONDS:-30}"
OSM_DOWNLOAD_SPEED_LIMIT_BYTES="${OSM_DOWNLOAD_SPEED_LIMIT_BYTES:-1024}"

absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
preset_urls() {
  case "$1" in
    italy) printf '%s\n' "https://download.geofabrik.de/europe/italy-latest.osm.pbf" ;;
    france) printf '%s\n' "https://download.geofabrik.de/europe/france-latest.osm.pbf" ;;
    germany) printf '%s\n' "https://download.geofabrik.de/europe/germany-latest.osm.pbf" ;;
    spain) printf '%s\n' "https://download.geofabrik.de/europe/spain-latest.osm.pbf" ;;
    switzerland) printf '%s\n' "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" ;;
    austria) printf '%s\n' "https://download.geofabrik.de/europe/austria-latest.osm.pbf" ;;
    slovenia) printf '%s\n' "https://download.geofabrik.de/europe/slovenia-latest.osm.pbf" ;;
    croatia) printf '%s\n' "https://download.geofabrik.de/europe/croatia-latest.osm.pbf" ;;
    monaco)
      printf '%s\n' \
        "https://download.openstreetmap.fr/extracts/europe/monaco-latest.osm.pbf" \
        "https://download.geofabrik.de/europe/monaco-latest.osm.pbf"
      ;;
    *) return 1 ;;
  esac
}

mkdir -p "$OSM_DATA_DIR"

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is not installed: $command_name" >&2
    return 1
  fi
}

for dependency in curl osmium stat; do
  require_command "$dependency" || exit 69
done

validate_osm_file() {
  local host_file="$1" minimum_bytes="${2:-$OSM_DOWNLOAD_MIN_BYTES}"

  if [[ ! -f "$host_file" ]]; then
    echo "OSM validation failed: file does not exist: $host_file" >&2
    return 1
  fi

  local bytes
  bytes="$(stat -c %s "$host_file" 2>/dev/null || printf '0')"
  if (( bytes < minimum_bytes )); then
    echo "OSM validation failed: $host_file contains $bytes bytes; minimum required is $minimum_bytes" >&2
    return 1
  fi

  local validation_output
  if ! validation_output="$(osmium fileinfo "$host_file" 2>&1)"; then
    echo "OSM validation failed: osmium rejected $host_file" >&2
    printf '%s\n' "$validation_output" >&2
    return 1
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
  if ! mapfile -t urls < <(preset_urls "$region"); then
    echo "Unknown OSM region preset: $region. Supported presets: italy, france, germany, spain, switzerland, austria, slovenia, croatia, monaco." >&2
    exit 64
  fi
  [[ ${#urls[@]} -gt 0 ]] || { echo "No download URL configured for region: $region" >&2; exit 64; }
  target="$OSM_DATA_DIR/$region.osm.pbf"
  tmp_target="$OSM_DATA_DIR/$region.download.osm.pbf"
  alerts_target="$OSM_DATA_DIR/$region.alerts.osm"
  reused_download=false
  if [[ "$OSM_REUSE_EXISTING_DOWNLOADS" == "true" ]] && validate_osm_file "$target"; then
    reused_download=true
    rm -f "$tmp_target"
    target_bytes="$(stat -c %s "$target")"
    echo "{\"event\":\"osm_download_reused\",\"region\":\"$region\",\"bytes\":$target_bytes}"
  else
    download_succeeded=false
    selected_url=""
    rm -f "$tmp_target"

    for url in "${urls[@]}"; do
      echo "Downloading OSM extract for $region from $url"
      rm -f "$tmp_target"

      if curl \
        --fail \
        --location \
        --show-error \
        --silent \
        --retry "$OSM_DOWNLOAD_RETRIES" \
        --retry-delay "$OSM_DOWNLOAD_RETRY_DELAY_SECONDS" \
        --retry-all-errors \
        --connect-timeout "$OSM_DOWNLOAD_CONNECT_TIMEOUT_SECONDS" \
        --max-time "$OSM_DOWNLOAD_MAX_TIME_SECONDS" \
        --speed-time "$OSM_DOWNLOAD_SPEED_TIME_SECONDS" \
        --speed-limit "$OSM_DOWNLOAD_SPEED_LIMIT_BYTES" \
        --user-agent "ignition-ci-osm-downloader/1.0" \
        --output "$tmp_target" \
        "$url"; then
        downloaded_bytes="$(stat -c %s "$tmp_target" 2>/dev/null || printf '0')"
        if (( downloaded_bytes >= OSM_DOWNLOAD_MIN_BYTES )) && \
          validate_osm_file "$tmp_target"; then
          download_succeeded=true
          selected_url="$url"
          break
        fi
        echo "Downloaded file from $url failed size or OSM validation (${downloaded_bytes} bytes)" >&2
      else
        echo "Download source failed for $region: $url" >&2
      fi
    done

    if [[ "$download_succeeded" != "true" ]]; then
      rm -f "$tmp_target"
      echo "All OSM download sources failed for region: $region" >&2
      exit 69
    fi

    downloaded_bytes="$(stat -c %s "$tmp_target")"
    echo "{\"event\":\"osm_download_completed\",\"region\":\"$region\",\"bytes\":$downloaded_bytes,\"source\":\"$selected_url\"}"
    mv "$tmp_target" "$target"
    echo "{\"event\":\"osm_download_promoted\",\"region\":\"$region\",\"target\":\"$target\"}"
  fi

  reuse_alerts=false
  if [[ "$OSM_REUSE_EXISTING_DOWNLOADS" == "true" && -f "$alerts_target" && "$alerts_target" -nt "$target" ]] && \
    validate_osm_file "$alerts_target" "$OSM_ALERT_EXTRACT_MIN_BYTES"; then
    reuse_alerts=true
  fi

  if [[ "$reuse_alerts" == "true" ]]; then
    alerts_bytes="$(stat -c %s "$alerts_target")"
    echo "{\"event\":\"osm_alerts_reused\",\"region\":\"$region\",\"bytes\":$alerts_bytes}"
  else
    echo "{\"event\":\"osm_alert_extraction_started\",\"region\":\"$region\"}"
    if ! osmium tags-filter "$target" "${filters[@]}" --overwrite --output "$alerts_target"; then
      echo "Failed to extract OSM alerts for region: $region" >&2
      rm -f "$alerts_target"
      exit 65
    fi
    if ! validate_osm_file "$alerts_target" "$OSM_ALERT_EXTRACT_MIN_BYTES"; then
      echo "Prepared alert extract for $region is not a valid OSM file" >&2
      rm -f "$alerts_target"
      exit 65
    fi
    alerts_bytes="$(stat -c %s "$alerts_target")"
    echo "{\"event\":\"osm_alert_extraction_completed\",\"region\":\"$region\",\"bytes\":$alerts_bytes}"
  fi
  echo "{\"event\":\"osm_region_prepared\",\"region\":\"$region\",\"downloadReused\":$reused_download,\"alertsReused\":$reuse_alerts}"
done
