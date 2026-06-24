#!/usr/bin/env bash
set -euo pipefail

VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
OUTPUT_DIR="${OUTPUT_DIR:-./dist-artifacts}"
REGION="${OSM_REGIONS:-italy}"
REGION="${REGION//,/+}"
REGION="${REGION// /}"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

VALHALLA_TILE_DIR="$(absolute_path "$VALHALLA_TILE_DIR")"
OUTPUT_DIR="$(absolute_path "$OUTPUT_DIR")"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
ARCHIVE="$OUTPUT_DIR/${REGION}-valhalla-tiles-${STAMP}.tar.gz"
MANIFEST="$OUTPUT_DIR/${REGION}-valhalla-tiles-${STAMP}.manifest.json"

if [[ ! -f "$VALHALLA_TILE_DIR/valhalla.json" ]]; then
  echo "Missing $VALHALLA_TILE_DIR/valhalla.json" >&2
  exit 1
fi

if [[ ! -d "$VALHALLA_TILE_DIR/valhalla_tiles" ]]; then
  echo "Missing $VALHALLA_TILE_DIR/valhalla_tiles" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
tar \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --mode='u+rwX,go+rX' \
  -C "$VALHALLA_TILE_DIR" \
  -czf "$ARCHIVE" \
  valhalla.json \
  valhalla_tiles

ARCHIVE="$ARCHIVE" \
  MANIFEST="$MANIFEST" \
  VALHALLA_TILE_DIR="$VALHALLA_TILE_DIR" \
  REGION="$REGION" \
  node -e "const fs=require('fs'); const crypto=require('crypto'); const archive=process.env.ARCHIVE; const hash=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'); const manifest={region:process.env.REGION,createdAt:new Date().toISOString(),sourceTileDir:process.env.VALHALLA_TILE_DIR,archive,sha256:hash,bytes:fs.statSync(archive).size}; fs.writeFileSync(process.env.MANIFEST, JSON.stringify(manifest,null,2)+'\n'); console.log(JSON.stringify(manifest));"
