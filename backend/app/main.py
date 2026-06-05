"""FastAPI 애플리케이션 진입점.

실행: uvicorn app.main:app --reload  (backend 디렉터리에서)
문서: http://localhost:8000/docs
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .data_meta import get_history_meta
from .database import get_last_data_source
from .routers import analyze, data, generate, history, meta, patterns, recommend, stats
from .scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(
    title="Lotto Analyzer API",
    description="역대 로또 당첨 데이터 기반 통계 분석 및 번호 추천 API",
    version="1.0.0",
    lifespan=lifespan,
)

_cors_origins = [
    o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()
] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 도메인별 라우터 등록
app.include_router(stats.router)
app.include_router(analyze.router)
app.include_router(patterns.router)
app.include_router(generate.router)
app.include_router(history.router)
app.include_router(recommend.router)
app.include_router(meta.router)
app.include_router(data.router)


@app.get("/health", tags=["system"])
def health_check():
    """헬스 체크: API·데이터 소스·회차 커버리지 요약."""
    meta_info = get_history_meta()
    return {
        "status": "ok" if meta_info.get("ok") else "degraded",
        "data_source": get_last_data_source(),
        **{k: meta_info[k] for k in ("row_count", "latest_round", "current_round", "gap_count", "is_complete") if k in meta_info},
    }
