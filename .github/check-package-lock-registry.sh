#!/usr/bin/env bash
set -euo pipefail

lockfile="${1:-backend/package-lock.json}"

if grep -Eq 'applied-caas-gateway|internal\.api\.openai\.org|artifactory/api/npm' "$lockfile"; then
  echo "Error: package-lock.json contains a private/internal npm registry URL." >&2
  grep -En 'applied-caas-gateway|internal\.api\.openai\.org|artifactory/api/npm' "$lockfile" >&2 || true
  exit 1
fi

if grep -E '"resolved": "https?://' "$lockfile" | grep -v 'https://registry.npmjs.org/' >/dev/null; then
  echo "Error: package-lock.json contains resolved URLs outside registry.npmjs.org:" >&2
  grep -E '"resolved": "https?://' "$lockfile" | grep -v 'https://registry.npmjs.org/' >&2 || true
  exit 1
fi

echo "package-lock registry URLs are public and portable"
