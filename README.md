# 로또 분석기 (Lotto Analyzer)

역대 로또 당첨 데이터를 기반으로 통계 분석을 제공하고, 가중치 기반으로 번호를 추천하는 풀스택 앱입니다.

| 버전 | 경로 | 설명 |
|------|------|------|
| **통합 웹 앱** | [`platform/frontend/`](platform/frontend/) | 대시보드·번호생성·회차추천·연구분석 (단일 URL) |
| v1 API | `backend/` | 일반 앱 REST API (포트 8000) |
| v2 API | `platform/backend/` | 연구 플랫폼 REST API (포트 8100) |
| v1 Expo (레거시) | `frontend/` | 모바일/Expo 전용 — 통합 웹 앱으로 대체됨 |

**v1 설계서:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)  
**v2 실행:** [platform/README.md](platform/README.md)  
**데이터 격리:** [docs/DATA_ISOLATION.md](docs/DATA_ISOLATION.md)  
**공개 저장소:** [github.com/seulform-design/seulkilotto](https://github.com/seulform-design/seulkilotto)

## 용지 분석 (5천원 자동 용지)

통합 웹 앱 **용지 분석** 탭에서 5천원 자동번호 영수증을 분석합니다.

| 항목 | 설명 |
|------|------|
| **5×6 형식** | A~E 게임 줄 × 줄당 6번호 (7×7 OMR 마킹 격자와 별개) |
| **수기 입력 (권장)** | 1~45 번호 그리드에서 6개 탭 → **줄 저장** (A→E) → 용지 누적 → **분석·저장** |
| **복기 / 이번회차** | 탭별로 줄·용지 누적, 다른 줄·다른 용지 간 2·3·4번호 겹침 통계 |
| **사진 업로드 (선택)** | 영수증 OCR 또는 OMR 격자 인식 — 수기 입력이 기본 UX |

```bash
# 수기 분석 API
POST /api/v1/photo-analysis/manual
# body: { "sheet_intent": "review"|"current_round", "slips": [{ "lines": [{ "label": "A", "numbers": [...] }] }] }
```

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React Native (TypeScript) · Expo |
| 백엔드 / 분석 | Python · FastAPI · Pandas · NumPy |
| 데이터베이스 | PostgreSQL |

## 프로젝트 구조

```
lotto-analyzer/
├── backend/
│   ├── sql/schema.sql            # DDL + 인덱스 + 트리거 + 샘플 데이터
│   ├── requirements.txt
│   └── app/
│       ├── main.py               # FastAPI 진입점
│       ├── config.py             # 환경설정(DB URL, 가중치 파라미터)
│       ├── database.py           # DB 로딩 + 모의 데이터 폴백
│       ├── schemas.py            # Pydantic 입출력 스키마
│       ├── analytics.py          # 핵심 분석 알고리즘 (Pandas)
│       └── routers/              # stats / analyze / generate 엔드포인트
└── frontend/
    ├── App.tsx                   # 루트 + 하단 탭 (대시보드·번호생성·회차추천)
    └── src/
        ├── theme/colors.ts       # 디자인 토큰 + 공식 볼 색상 매핑
        ├── api/client.ts         # 백엔드 API 클라이언트
        ├── components/           # LottoBall, OddEvenBar
        └── screens/              # DashboardScreen, GeneratorScreen (기획서 필수)
```

## 실행 방법 (통합 웹 앱)

**로컬 주소:** http://localhost:5173  
**공개 배포:** [deploy/README.md](deploy/README.md) 참고 (Render 영구 배포 / localtunnel 즉시 공개)

터미널 3개에서 각각 실행:

```bash
# 1) v1 API (대시보드·번호생성·회차추천)
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 2) v2 API (연구 분석)
cd platform/backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8100

# 3) 통합 프론트엔드
cd platform/frontend
npm install
npm run dev
```

> DB 미연결 시 v1 API는 CSV → 모의 데이터 순으로 자동 폴백합니다.

### (선택) PostgreSQL
```bash
psql -U postgres -d lotto -f backend/sql/schema.sql
```

### (레거시) Expo 모바일 앱
```bash
cd frontend && npm install && npm start
```

## 주요 API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET  | `/api/v1/stats/frequency?recent_n=` | 번호별 출현 빈도/비율 |
| POST | `/api/v1/analyze/combination` | 6개 조합의 홀짝/총합/연속번호 분석 |
| GET  | `/api/v1/generate/weights?n_sets=&lookback=&exclude_consecutive=` | 미출현 번호 +15% 가중 추천 |

## 기획서 대응 체크리스트

- [x] PostgreSQL DDL + 인덱스 + 롱 테이블 (`backend/sql/schema.sql`)
- [x] `GET /stats/frequency`, `POST /analyze/combination`, `GET /generate/weights`
- [x] `DashboardScreen` (공식 볼 색 + 홀짝 바)
- [x] `GeneratorScreen` (필터 + 페이드인 생성)
