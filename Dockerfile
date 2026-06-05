# ---- Frontend build ----
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY platform/frontend/package.json platform/frontend/package-lock.json* ./
RUN npm ci
COPY platform/frontend/ ./
RUN npm run build

# ---- Production image ----
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /tmp/v1-requirements.txt
COPY platform/backend/requirements.txt /tmp/v2-requirements.txt
RUN pip install --no-cache-dir -r /tmp/v1-requirements.txt -r /tmp/v2-requirements.txt

COPY backend/ /app/backend/
COPY platform/backend/ /app/platform/backend/
COPY backend/data/lotto_history.csv /app/backend/data/lotto_history.csv

RUN cd /app/platform/backend \
    && python scripts/seed_from_csv.py --csv /app/backend/data/lotto_history.csv

COPY --from=frontend-build /build/dist /app/frontend/dist
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/start-docker.sh /start.sh
RUN chmod +x /start.sh

ENV PORT=10000
ENV SCHEDULER_ENABLED=true
ENV CRAWL_SOURCE=lottis
EXPOSE 10000
CMD ["/start.sh"]
