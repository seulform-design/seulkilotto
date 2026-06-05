# 로또 패턴 연구 · 검증 플랫폼 (v2)

> **면책:** 로또는 독립시행 확률 게임입니다. 본 플랫폼은 미래 당첨을 보장하지 않으며, 모든 결과는 과거 데이터 기반 통계·백테스트 산출물입니다.

## 구조

```
platform/
├── docker-compose.yml
├── backend/          # FastAPI + SQLAlchemy 2 + Pandas + scikit-learn
│   ├── alembic/
│   ├── app/
│   │   ├── models/       # ORM
│   │   ├── repositories/ # DB 접근
│   │   ├── services/     # 비즈니스 로직
│   │   ├── engines/      # 21개 분석 엔진
│   │   ├── api/          # REST (/api/*)
│   │   └── schemas/      # Pydantic
│   └── tests/
└── frontend/         # React + Vite + MUI + Recharts
```

## 실행 (통합 웹 앱)

**사이트:** http://localhost:5173 — 대시보드 · 번호생성 · 회차추천 · 연구분석 탭

```bash
# 터미널 1 — v1 API
cd backend && python -m uvicorn app.main:app --reload --port 8000

# 터미널 2 — v2 API
cd platform/backend
pip install -r requirements.txt
python scripts/seed_from_csv.py
uvicorn app.main:app --reload --port 8100

# 터미널 3 — 통합 프론트
cd platform/frontend && npm install && npm run dev
```

## 로드맵 (완료)

1. **Triple** — `GET /api/triple-matrix?mode=top|anchor&anchor=7`
2. **FP-Growth** — `GET /api/rules?method=fpgrowth`
3. **pytest** — `pytest tests/` (`pytest-cov`로 커버리지 측정)
4. **APScheduler** — `SCHEDULER_ENABLED=true`, cron CSV 동기화 · `POST /api/admin/sync-csv`

## 실행 (Docker PostgreSQL)

```bash
cd platform
docker compose up -d
cd backend && alembic upgrade head && python scripts/seed_from_csv.py
```

- API: http://localhost:8100/docs
- UI: http://localhost:5173

## 기존 Expo 앱과의 관계

`lotto-analyzer/backend/` (CSV·Expo)는 유지됩니다.  
연구 플랫폼은 PostgreSQL·백테스트·조건부 확률에 특화된 **v2** 입니다.
