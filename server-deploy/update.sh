#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and configure IGNITION_IMAGE first." >&2
  exit 1
fi

echo "Pulling current images..."
docker compose pull

echo "Applying the new images and configuration..."
docker compose up -d --remove-orphans

echo "Current service status:"
docker compose ps
