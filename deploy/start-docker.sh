#!/bin/sh
set -e

export PORT="${PORT:-10000}"
V1_PID=""
V2_PID=""
NGINX_PID=""

wait_for_http() {
  url="$1"
  label="$2"
  timeout="${3:-90}"
  start_ts="$(date +%s)"
  while true; do
    if python - "$url" <<'PY'
import sys, urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=3) as r:
        code = r.getcode()
    raise SystemExit(0 if code and code < 500 else 1)
except Exception:
    raise SystemExit(1)
PY
    then
      echo "[ready] ${label}"
      return 0
    fi
    now_ts="$(date +%s)"
    if [ $((now_ts - start_ts)) -ge "$timeout" ]; then
      echo "[fatal] ${label} health timeout: ${url}" >&2
      return 1
    fi
    sleep 1
  done
}

shutdown_all() {
  for pid in "$NGINX_PID" "$V2_PID" "$V1_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap 'shutdown_all' INT TERM EXIT

start_v1() {
  cd /app/backend
  python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
  V1_PID=$!
  wait_for_http "http://127.0.0.1:8000/health" "v1 backend"
}

start_v2() {
  cd /app/platform/backend
  python -m uvicorn app.main:app --host 127.0.0.1 --port 8100 &
  V2_PID=$!
  wait_for_http "http://127.0.0.1:8100/health" "v2 backend"
}

start_v1
start_v2

envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
nginx -g 'daemon off;' &
NGINX_PID=$!

echo "[start] nginx pid=${NGINX_PID}, v1 pid=${V1_PID}, v2 pid=${V2_PID}"

while true; do
  if ! kill -0 "$V1_PID" 2>/dev/null; then
    echo "[warn] v1 backend exited; attempting restart" >&2
    start_v1 || {
      echo "[fatal] v1 backend restart failed; stopping container for Railway restart" >&2
      exit 1
    }
  fi
  if ! kill -0 "$V2_PID" 2>/dev/null; then
    echo "[warn] v2 backend exited; attempting restart" >&2
    start_v2 || {
      echo "[fatal] v2 backend restart failed; stopping container for Railway restart" >&2
      exit 1
    }
  fi
  if ! kill -0 "$NGINX_PID" 2>/dev/null; then
    echo "[fatal] nginx exited; stopping container" >&2
    exit 1
  fi
  sleep 2
done
