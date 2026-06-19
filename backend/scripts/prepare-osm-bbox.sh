#!/usr/bin/env bash
set -euo pipefail

OSM_EXTRACT_URL="${OSM_EXTRACT_URL:-}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_REGION="${OSM_REGION:-bbox-extract}"
OSM_BBOX="${OSM_BBOX:-}"

if [[ -z "$OSM_EXTRACT_URL" ]]; then
  echo "Set OSM_EXTRACT_URL to an explicit .osm.pbf extract URL, or use npm run osm:bbox:direct for small on-demand bboxes." >&2
  exit 1
fi

if [[ -z "$OSM_BBOX" ]]; then
  echo "Set OSM_BBOX=minLon,minLat,maxLon,maxLat, for example:" >&2
  echo "OSM_BBOX=11.80,45.35,12.10,45.55 npm run osm:bbox" >&2
  exit 1
fi

mkdir -p "$OSM_DATA_DIR"
source_pbf="$OSM_DATA_DIR/$OSM_REGION.source.osm.pbf"
target_pbf="$OSM_DATA_DIR/$OSM_REGION.osm.pbf"

if [[ ! -f "$source_pbf" ]]; then
  echo "Downloading source extract from $OSM_EXTRACT_URL"
  curl -L --fail --output "$source_pbf.tmp" "$OSM_EXTRACT_URL"
  mv "$source_pbf.tmp" "$source_pbf"
fi

echo "Extracting bbox $OSM_BBOX"
if command -v osmium >/dev/null 2>&1; then
  osmium extract --bbox "$OSM_BBOX" --strategy smart --overwrite --output "$target_pbf" "$source_pbf"
else
  echo "osmium not found locally; using Docker image ghcr.io/osmcode/osmium-tool" >&2
  docker run --rm \
    -v "$(pwd)/$OSM_DATA_DIR:/data" \
    ghcr.io/osmcode/osmium-tool:latest \
    osmium extract --bbox "$OSM_BBOX" --strategy smart --overwrite --output "/data/$OSM_REGION.osm.pbf" "/data/$OSM_REGION.source.osm.pbf"
fi

echo "Prepared $target_pbf"
echo "Now run: npm run valhalla:build"
