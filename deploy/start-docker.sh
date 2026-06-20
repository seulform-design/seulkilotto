#!/bin/sh
set -e

export PORT="${PORT:-10000}"

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

cd /app/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &

cd /app/platform/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8100 &

wait_for_http "http://127.0.0.1:8000/health" "v1 backend"
wait_for_http "http://127.0.0.1:8100/health" "v2 backend"

envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
