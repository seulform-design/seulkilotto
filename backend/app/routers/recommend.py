"""다음 회차 추천 API (/api/v1/recommend)."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..classic_methods import METHOD_IDS, build_classic_recommendation
from ..data_meta import effective_current_round
from ..database import load_history
from ..json_utils import to_jsonable
from ..machine_analytics import (
    attach_machine_column,
    build_round_recommendation,
    machine_overview,
    machine_profile,
    simulate_machine_draw,
)
from ..video_analysis.store import record_current_rule_engine_output

router = APIRouter(prefix="/api/v1/recommend", tags=["recommend"])


class NumberCount(BaseModel):
    number: int
    count: int


class NumberGap(BaseModel):
    number: int
    gap_rounds: int


class PairCount(BaseModel):
    pair: List[int]
    count: int


class MachineStatsSummary(BaseModel):
    draw_count: int
    hot_top5: List[NumberCount] = []
    cold_top5: List[NumberGap] = []
    consecutive_top3: List[PairCount] = []
    synergy_top3: List[PairCount] = []
    avg_sum: float = 0.0
    avg_odd: float = 0.0


class RoundCombo(BaseModel):
    numbers: List[int]
    sum_total: int
    odd_count: int
    even_count: int
    pattern: Optional[str] = None
    pattern_label: Optional[str] = None


class RoundRecommendResponse(BaseModel):
    next_round: int = Field(..., description="추천 대상 다음 회차")
    next_draw_date: str
    machine_id: int = Field(..., description="분석에 사용한 호기 1~3")
    auto_machine_id: int = Field(..., description="자동 예측 호기(실측/순환)")
    machine_source: Optional[str] = Field(default=None, description="confirmed | estimated")
    machine_data_coverage: Optional[dict] = None
    latest_round: int
    stats: MachineStatsSummary
    combinations: List[RoundCombo]
    warning: Optional[str] = None
    filter_rule: str
    compose_rule: str


@router.get("/round", response_model=RoundRecommendResponse)
def recommend_next_round(
    machine: Optional[int] = Query(
        default=None,
        ge=1,
        le=3,
        description="분석 호기 (1~3). 미지정 시 자동 예측 호기",
    ),
    seed: Optional[int] = Query(default=None, description="난수 시드"),
    scope: str = Query(default="ephemeral", description="ephemeral | current"),
):
    """다음 회차 호기 패턴 기반 추천 번호 5게임을 반환한다."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")

    payload = build_round_recommendation(df, machine_id=machine, seed=seed)
    if scope == "current":
        record_current_rule_engine_output(
            "round_recommendation",
            round_no=int(payload["next_round"]),
            latest_round=int(payload["latest_round"]),
            payload=payload,
            rule_snapshot={
                "machine": machine,
                "seed": seed,
                "filter_rule": payload.get("filter_rule"),
                "compose_rule": payload.get("compose_rule"),
                "auto_machine_id": payload.get("auto_machine_id"),
                "machine_id": payload.get("machine_id"),
            },
        )
    if not payload["combinations"] and payload["stats"].get("draw_count", 0) == 0:
        raise HTTPException(
            status_code=404,
            detail=f"{payload['machine_id']}호기 데이터가 없습니다. 다른 호기를 선택하세요.",
        )
    return payload


@router.get("/machine-draw")
def machine_draw_endpoint(
    machine: int = Query(..., ge=1, le=3, description="추첨할 호기 1~3"),
    seed: Optional[int] = Query(default=None, description="난수 시드(재현용)"),
):
    """호기별 볼 추첨기 시뮬레이터 — 해당 호기 실제 데이터 성향으로 볼 7개 추첨."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    return to_jsonable(simulate_machine_draw(df, machine, seed=seed))


@router.get("/machine-profile")
def machine_profile_endpoint(
    machine: int = Query(..., ge=1, le=3, description="호기 1~3"),
):
    """호기별 실측 성향 프로파일 — 추첨 없이 역대 누적 데이터 역산 결과만 반환."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    return to_jsonable(machine_profile(attach_machine_column(df), machine))


@router.get("/machine-overview")
def machine_overview_endpoint():
    """추첨기 호기 현황 — 실측 커버리지, 최근 순환 이력, 다음 회차 예측, 호기별 통계."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    return to_jsonable(machine_overview(df))


class ClassicRecommendResponse(BaseModel):
    next_round: int
    next_draw_date: str
    method: str
    latest_round: int
    pattern_analysis: dict
    combinations: List[RoundCombo]
    warning: Optional[str] = None
    filter_rule: str
    compose_rule: str


@router.get("/classic", response_model=ClassicRecommendResponse)
def recommend_classic(
    method: str = Query(
        default="blend",
        description="wilson|gauss|huygens|fermat|blend",
    ),
    seed: Optional[int] = Query(default=None),
    recent_n: Optional[int] = Query(default=None, ge=1),
    scope: str = Query(default="ephemeral", description="ephemeral | current"),
):
    """윌슨·가우스·호이겐스·페르마 패턴 기반 추천 번호."""
    if method.lower() not in METHOD_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"method 는 {', '.join(METHOD_IDS)} 중 하나여야 합니다.",
        )
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    payload = to_jsonable(
        build_classic_recommendation(df, method=method, seed=seed, recent_n=recent_n)
    )
    if scope == "current":
        record_current_rule_engine_output(
            "classic_recommendation",
            round_no=effective_current_round(int(df["round"].max())),
            latest_round=int(df["round"].max()),
            payload=payload,
            rule_snapshot={
                "method": method,
                "seed": seed,
                "recent_n": recent_n,
                "filter_rule": payload.get("filter_rule"),
                "compose_rule": payload.get("compose_rule"),
            },
        )
    return payload
