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
# CRLF 방어: `railway up` 은 (Windows) 워킹트리를 그대로 업로드해 start.sh 가 CRLF 면
# shebang 이 `#!/bin/sh\r` 로 깨져 컨테이너가 `/start.sh` 를 exec 못 한다(No such file).
# 소스 줄끝과 무관하게 CR 을 제거해 항상 실행 가능하게 한다(nginx 템플릿도 함께 정리).
RUN sed -i 's/\r$//' /start.sh /etc/nginx/templates/default.conf.template \
    && chmod +x /start.sh

ENV PORT=10000
ENV SCHEDULER_ENABLED=true
ENV CRAWL_SOURCE=lottis
EXPOSE 10000
CMD ["/start.sh"]
