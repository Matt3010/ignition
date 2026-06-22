#!/usr/bin/env bash
set -euo pipefail

MAX_ATTEMPTS="${NPM_CI_MAX_ATTEMPTS:-2}"
TIMEOUT_SECONDS="${NPM_CI_TIMEOUT_SECONDS:-360}"
HEARTBEAT_SECONDS="${NPM_CI_HEARTBEAT_SECONDS:-30}"

print_latest_log() {
  local latest_log
  latest_log="$(find "${HOME}/.npm/_logs" -type f -name '*-debug-0.log' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)"
  if [[ -n "${latest_log}" && -f "${latest_log}" ]]; then
    echo "----- latest npm debug log (last 200 lines) -----"
    tail -n 200 "${latest_log}" || true
    echo "----- end npm debug log -----"
  fi
}

run_npm_ci() {
  local npm_pid heartbeat_pid started_at now status timed_out=0

  npm ci --no-audit --no-fund --loglevel=notice &
  npm_pid=$!
  started_at="$(date +%s)"

  (
    while kill -0 "${npm_pid}" 2>/dev/null; do
      sleep "${HEARTBEAT_SECONDS}"
      if kill -0 "${npm_pid}" 2>/dev/null; then
        echo "npm ci is still running..."
      fi
    done
  ) &
  heartbeat_pid=$!

  while kill -0 "${npm_pid}" 2>/dev/null; do
    sleep 2
    now="$(date +%s)"
    if (( now - started_at >= TIMEOUT_SECONDS )); then
      timed_out=1
      echo "npm ci exceeded ${TIMEOUT_SECONDS} seconds; terminating it"
      kill -TERM "${npm_pid}" 2>/dev/null || true
      sleep 15
      if kill -0 "${npm_pid}" 2>/dev/null; then
        kill -KILL "${npm_pid}" 2>/dev/null || true
      fi
      break
    fi
  done

  set +e
  wait "${npm_pid}"
  status=$?
  set -e

  kill "${heartbeat_pid}" 2>/dev/null || true
  wait "${heartbeat_pid}" 2>/dev/null || true

  if (( timed_out == 1 )); then
    return 124
  fi

  return "${status}"
}

attempt=1
while (( attempt <= MAX_ATTEMPTS )); do
  echo "npm ci attempt ${attempt}/${MAX_ATTEMPTS}"
  node --version
  npm --version

  rm -rf node_modules

  if run_npm_ci; then
    exit 0
  else
    status=$?
  fi

  if [[ "${status}" -eq 124 ]]; then
    echo "npm ci timed out after ${TIMEOUT_SECONDS} seconds"
  else
    echo "npm ci failed with exit code ${status}"
  fi

  print_latest_log

  if (( attempt == MAX_ATTEMPTS )); then
    exit "${status}"
  fi

  echo "Cleaning npm cache before retry"
  npm cache clean --force || true
  sleep 5
  attempt=$((attempt + 1))
done
