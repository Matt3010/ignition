#!/usr/bin/env bash
set -euo pipefail

OSM_EXTRACT_URL="${OSM_EXTRACT_URL:-https://download.geofabrik.de/europe/italy/nord-est-latest.osm.pbf}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_REGION="${OSM_REGION:-veneto}"

mkdir -p "$OSM_DATA_DIR"
target="$OSM_DATA_DIR/$OSM_REGION.osm.pbf"

echo "Downloading OSM extract from $OSM_EXTRACT_URL"
echo "Target: $target"
curl -L --fail --output "$target.tmp" "$OSM_EXTRACT_URL"
mv "$target.tmp" "$target"
echo "Done"
