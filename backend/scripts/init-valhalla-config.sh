#!/usr/bin/env bash
set -euo pipefail

TEMPLATE_PATH="${VALHALLA_CONFIG_TEMPLATE:-/app/docker/valhalla/valhalla.json}"
TARGET_PATH="${VALHALLA_CONFIG_PATH:-/app/data/valhalla/valhalla.json}"
TARGET_DIR="$(dirname "$TARGET_PATH")"
TEMP_PATH="${TARGET_PATH}.tmp.$$"

validate_json() {
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const raw = fs.readFileSync(path, "utf8");
    if (raw.trim().length === 0) process.exit(1);
    JSON.parse(raw);
  ' "$1" >/dev/null 2>&1
}

if [[ ! -f "$TEMPLATE_PATH" ]] || ! validate_json "$TEMPLATE_PATH"; then
  echo "Valhalla configuration template is missing or invalid: $TEMPLATE_PATH" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

if [[ -f "$TARGET_PATH" ]] && validate_json "$TARGET_PATH"; then
  echo "Valhalla configuration already valid: $TARGET_PATH"
  exit 0
fi

cleanup() {
  rm -f "$TEMP_PATH"
}
trap cleanup EXIT

cp "$TEMPLATE_PATH" "$TEMP_PATH"
validate_json "$TEMP_PATH"
mv -f "$TEMP_PATH" "$TARGET_PATH"

echo "Valhalla configuration initialized: $TARGET_PATH"
