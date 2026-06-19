#!/usr/bin/env bash
set -euo pipefail

OSM_EXTRACT_URL="${OSM_EXTRACT_URL:-}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_REGION="${OSM_REGION:-extract}"

if [[ -z "$OSM_EXTRACT_URL" ]]; then
  echo "Set OSM_EXTRACT_URL to an explicit .osm.pbf extract URL." >&2
  exit 1
fi

mkdir -p "$OSM_DATA_DIR"
target="$OSM_DATA_DIR/$OSM_REGION.osm.pbf"

echo "Downloading OSM extract from $OSM_EXTRACT_URL"
echo "Target: $target"
curl -L --fail --output "$target.tmp" "$OSM_EXTRACT_URL"
mv "$target.tmp" "$target"
echo "Done"
