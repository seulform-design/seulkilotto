#!/bin/sh
set -e

export PORT="${PORT:-10000}"

cd /app/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &

cd /app/platform/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8100 &

sleep 2

envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
