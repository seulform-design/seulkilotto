"""
로또 패턴 연구 · 검증 플랫폼 API.

면책: 독립시행 확률 게임 — 과거 통계는 미래 당첨을 보장하지 않습니다.
문서: /docs  /redoc
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import router as research_router
from app.config import settings
from app.scheduler import start_scheduler, stop_scheduler


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

_cors_origins = [
    o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()
] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(research_router)


@app.get("/health")
def health():
    return {"status": "ok", "platform": "lotto-research-v2"}
