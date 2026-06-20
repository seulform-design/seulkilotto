"""FastAPI 애플리케이션 진입점.

실행: uvicorn app.main:app --reload  (backend 디렉터리에서)
문서: http://localhost:8000/docs
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .data_meta import get_history_meta
from .database import get_last_data_source
from .routers import (
    analyze,
    data,
    datasets,
    generate,
    history,
    meta,
    patterns,
    photo_analysis,
    post_occurrence,
    recommend,
    stats,
)
from .scheduler import start_scheduler, stop_scheduler


# 항상 허용하는 오리진 패턴.
# Quick Tunnel 의 가변 호스트네임, Render, 로컬을 정규식으로 처리하여
# .env 의 CORS_ORIGINS 를 매 부팅마다 갱신할 필요가 없도록 한다.
_DEFAULT_ORIGIN_PATTERNS = (
    r"https://[a-z0-9-]+\.trycloudflare\.com",
    r"https://[a-z0-9-]+\.onrender\.com",
    r"https://[a-z0-9-]+\.up\.railway\.app",
    r"http://localhost(:\d+)?",
    r"http://127\.0\.0\.1(:\d+)?",
)


def _build_cors_kwargs() -> dict:
    static_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]

    # 명시적 와일드카드("*") 가 지정된 경우 — 개발 환경 전용. allow_credentials 와 양립 불가.
    if static_origins == ["*"]:
        return {"allow_origins": ["*"], "allow_credentials": False}

    extra_patterns = [
        p.strip()
        for p in os.getenv("CORS_ORIGIN_REGEX_EXTRA", "").split(",")
        if p.strip()
    ]
    combined = "|".join(f"(?:{p})" for p in (*_DEFAULT_ORIGIN_PATTERNS, *extra_patterns))
    return {
        "allow_origins": static_origins,  # 정적 허용 목록 (escape hatch)
        "allow_origin_regex": combined,   # 패턴 허용 (Quick Tunnel 등)
        "allow_credentials": True,
    }


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

app.add_middleware(
    CORSMiddleware,
    allow_methods=["*"],
    allow_headers=["*"],
    **_build_cors_kwargs(),
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
app.include_router(post_occurrence.router)
app.include_router(photo_analysis.router)
app.include_router(datasets.router)


@app.get("/health", tags=["system"])
def health_check():
    """헬스 체크: API·데이터 소스·회차 커버리지 요약."""
    meta_info = get_history_meta()
    return {
        "status": "ok" if meta_info.get("ok") else "degraded",
        "data_source": get_last_data_source(),
        **{
            k: meta_info[k]
            for k in ("row_count", "latest_round", "current_round", "gap_count", "is_complete")
            if k in meta_info
        },
    }
