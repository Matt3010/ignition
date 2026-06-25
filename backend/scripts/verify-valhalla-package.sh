#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${OUTPUT_DIR:-./dist-artifacts}"
VALHALLA_DOCKER_IMAGE="${VALHALLA_DOCKER_IMAGE:-ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1}"
VALHALLA_DOCKER_PLATFORM="${VALHALLA_DOCKER_PLATFORM:-linux/amd64}"
VERIFY_CONTAINER_NAME="${VERIFY_CONTAINER_NAME:-ignition-ci-valhalla-package}"
VERIFY_PORT="${VERIFY_PORT:-8003}"

archive="$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name '*-valhalla-tiles-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[[ -n "$archive" && -f "$archive" ]] || { echo "No Valhalla package found in $OUTPUT_DIR" >&2; exit 1; }
manifest="${archive%.tar.gz}.manifest.json"
[[ -f "$manifest" ]] || { echo "Missing package manifest: $manifest" >&2; exit 1; }

expected="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(m.sha256)' "$manifest")"
actual="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual" == "$expected" ]] || { echo "Package SHA256 mismatch" >&2; exit 1; }

extract_dir="$(mktemp -d)"
# mktemp creates mode 0700. The Valhalla image runs as a non-root user, so the
# bind-mounted extraction root must be traversable by that user.
chmod 0755 "$extract_dir"
cleanup() {
  docker rm -f "$VERIFY_CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$extract_dir"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$extract_dir"

# Fail before Docker startup if the produced package is not portable to a
# non-root runtime. The package script normalizes these modes in the archive.
[[ -r "$extract_dir/valhalla.json" ]] || { echo "Packaged valhalla.json is not readable" >&2; exit 1; }
find "$extract_dir" -type d ! -perm -0005 -print -quit | grep -q . && {
  echo "Package contains a directory that is not traversable/readable by the Valhalla runtime" >&2
  exit 1
}
find "$extract_dir" -type f ! -perm -0004 -print -quit | grep -q . && {
  echo "Package contains a file that is not readable by the Valhalla runtime" >&2
  exit 1
}

[[ -f "$extract_dir/valhalla.json" ]] || { echo "Package misses valhalla.json" >&2; exit 1; }
[[ -d "$extract_dir/valhalla_tiles" ]] || { echo "Package misses valhalla_tiles" >&2; exit 1; }
find "$extract_dir/valhalla_tiles" -type f -name '*.gph' -print -quit | grep -q . || {
  echo "Package contains no graph tiles" >&2
  exit 1
}

docker run --detach \
  --name "$VERIFY_CONTAINER_NAME" \
  --platform "$VALHALLA_DOCKER_PLATFORM" \
  --publish "$VERIFY_PORT:8002" \
  --entrypoint valhalla_service \
  --volume "$extract_dir:/custom_files:ro" \
  "$VALHALLA_DOCKER_IMAGE" \
  /custom_files/valhalla.json 1 >/dev/null

for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${VERIFY_PORT}/status" >/dev/null; then
    curl --fail --silent --get \
      --data-urlencode 'json={"locations":[{"lat":43.737454,"lon":7.42492}],"costing":"auto"}' \
      "http://127.0.0.1:${VERIFY_PORT}/locate" >/dev/null
    echo "Valhalla package verified: $archive"
    exit 0
  fi
  sleep 2
done

docker logs "$VERIFY_CONTAINER_NAME" >&2 || true
exit 1
