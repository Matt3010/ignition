#!/usr/bin/env bash
set -euo pipefail

OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_REGION="${OSM_REGION:-bbox-test}"
OSM_BBOX="${OSM_BBOX:-}"
OSM_BBOX_API_URL="${OSM_BBOX_API_URL:-https://api.openstreetmap.org/api/0.6/map}"

if [[ -z "$OSM_BBOX" ]]; then
  echo "Set OSM_BBOX=minLon,minLat,maxLon,maxLat, for example:" >&2
  echo "OSM_BBOX=10.995,44.995,11.010,45.010 npm run osm:bbox:direct" >&2
  exit 1
fi

mkdir -p "$OSM_DATA_DIR"
xml_target="$OSM_DATA_DIR/$OSM_REGION.osm"
pbf_target="$OSM_DATA_DIR/$OSM_REGION.osm.pbf"

echo "Downloading direct OSM bbox $OSM_BBOX"
curl -L --fail \
  --get "$OSM_BBOX_API_URL" \
  --data-urlencode "bbox=$OSM_BBOX" \
  --output "$xml_target.tmp"
mv "$xml_target.tmp" "$xml_target"

echo "Converting $xml_target to $pbf_target"
if command -v osmium >/dev/null 2>&1; then
  osmium cat "$xml_target" --overwrite --output "$pbf_target"
else
  echo "osmium not found locally; using Docker image ghcr.io/osmcode/osmium-tool" >&2
  if docker run --rm \
    -v "$(pwd)/$OSM_DATA_DIR:/data" \
    ghcr.io/osmcode/osmium-tool:latest \
    osmium cat "/data/$OSM_REGION.osm" --overwrite --output "/data/$OSM_REGION.osm.pbf"; then
    true
  else
    echo "Dedicated osmium image unavailable; trying debian:bookworm + osmium-tool" >&2
    if ! docker run --rm \
      -v "$(pwd)/$OSM_DATA_DIR:/data" \
      debian:bookworm \
      bash -lc "apt-get update >/dev/null && apt-get install -y --no-install-recommends osmium-tool >/dev/null && osmium cat /data/$OSM_REGION.osm --overwrite --output /data/$OSM_REGION.osm.pbf"; then
      echo "Could not convert to PBF. Keeping XML extract at $xml_target." >&2
      echo "Install osmium-tool locally, then rerun this command." >&2
    fi
  fi
fi

if [[ -f "$pbf_target" ]]; then
  echo "Prepared $pbf_target"
else
  echo "Prepared $xml_target"
fi
echo "Now run: OSM_REGION=$OSM_REGION npm run valhalla:build"
