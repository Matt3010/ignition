#!/usr/bin/env bash
set -euo pipefail

max_attempts=2
attempt=1

while (( attempt <= max_attempts )); do
  echo "npm ci attempt ${attempt}/${max_attempts}"
  node --version
  npm --version

  rm -rf node_modules

  if npm ci --no-audit --no-fund; then
    exit 0
  else
    status=$?
  fi
  echo "npm ci failed with exit code ${status}"

  latest_log="$(find "${HOME}/.npm/_logs" -type f -name '*-debug-0.log' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)"
  if [[ -n "${latest_log}" && -f "${latest_log}" ]]; then
    echo "----- latest npm debug log (last 200 lines) -----"
    tail -n 200 "${latest_log}" || true
    echo "----- end npm debug log -----"
  fi

  if (( attempt == max_attempts )); then
    exit "${status}"
  fi

  echo "Cleaning npm cache before retry"
  npm cache clean --force || true
  sleep 5
  attempt=$((attempt + 1))
done
