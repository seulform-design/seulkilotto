"""
로또 패턴 연구 · 검증 플랫폼 API.

면책: 독립시행 확률 게임 — 과거 통계는 미래 당첨을 보장하지 않습니다.
문서: /docs  /redoc
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import router as research_router
from app.config import settings
from app.scheduler import start_scheduler, stop_scheduler


# 항상 허용하는 오리진 패턴. v1 백엔드와 동일 정책.
_DEFAULT_ORIGIN_PATTERNS = (
    r"https://[a-z0-9-]+\.trycloudflare\.com",
    r"https://[a-z0-9-]+\.onrender\.com",
    r"https://[a-z0-9-]+\.up\.railway\.app",
    r"http://localhost(:\d+)?",
    r"http://127\.0\.0\.1(:\d+)?",
)


def _build_cors_kwargs() -> dict:
    static_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]

    if static_origins == ["*"]:
        return {"allow_origins": ["*"], "allow_credentials": False}

    extra_patterns = [
        p.strip()
        for p in os.getenv("CORS_ORIGIN_REGEX_EXTRA", "").split(",")
        if p.strip()
    ]
    combined = "|".join(f"(?:{p})" for p in (*_DEFAULT_ORIGIN_PATTERNS, *extra_patterns))
    return {
        "allow_origins": static_origins,
        "allow_origin_regex": combined,
        "allow_credentials": True,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(
    title="Lotto Research Platform",
    description=(
        "조건부 확률 · Pair/Triple 패턴 · 백테스트 · 통계 검증 연구 API. "
        "모든 응답은 과거 데이터 기반이며 당첨을 보장하지 않습니다."
    ),
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_methods=["*"],
    allow_headers=["*"],
    **_build_cors_kwargs(),
)

app.include_router(research_router)


@app.get("/health")
def health():
    return {"status": "ok", "platform": "lotto-research-v2"}
