"""윌슨·가우스·호이겐스·페르마 패턴 분석 API."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..classic_methods import METHOD_IDS, analyze_all_classic
from ..database import load_history

router = APIRouter(prefix="/api/v1/analyze", tags=["analyze"])


class PatternNumberScore(BaseModel):
    number: int
    count: Optional[int] = None
    wilson_lower: Optional[float] = None
    gap_rounds: Optional[int] = None
    overdue_ratio: Optional[float] = None


class PatternPairScore(BaseModel):
    pair: List[int]
    count: int


class PatternSummary(BaseModel):
    method: str
    label: str
    description: str
    top10: Optional[List[Dict[str, Any]]] = None
    top_pairs: Optional[List[PatternPairScore]] = None
    sum_mean: Optional[float] = None
    sum_std: Optional[float] = None
    sum_band: Optional[List[int]] = None
    odd_mean: Optional[float] = None
    expected_gap: Optional[float] = None
    trials: Optional[int] = None


class PatternsResponse(BaseModel):
    latest_round: int
    recent_n: Optional[int] = None
    patterns: Dict[str, PatternSummary]


@router.get("/patterns", response_model=PatternsResponse)
def get_pattern_analysis(
    recent_n: Optional[int] = Query(default=None, ge=1, description="최근 N회만 분석"),
):
    """윌슨·가우스·호이겐스·페르마 4가지 패턴 분석 요약."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")

    raw = analyze_all_classic(df, recent_n=recent_n)
    patterns = {
        k: PatternSummary(**{kk: vv for kk, vv in v.items() if not kk.startswith("_")})
        for k, v in raw.items()
    }
    return PatternsResponse(
        latest_round=int(df["round"].max()),
        recent_n=recent_n,
        patterns=patterns,
    )


@router.get("/patterns/methods")
def list_pattern_methods():
    """지원 패턴 ID 목록."""
    return {
        "methods": [
            {"id": "wilson", "label": "윌슨법", "hint": "Wilson score 하한 — 안정 출현"},
            {"id": "gauss", "label": "가우스법", "hint": "총합·홀짝 정규분포 μ±σ"},
            {"id": "huygens", "label": "호이겐스법", "hint": "기대 gap 대비 미출현"},
            {"id": "fermat", "label": "페르마법", "hint": "2번호 동시출현·소수"},
            {"id": "blend", "label": "4법 통합", "hint": "각 1게임씩 5조합"},
        ]
    }
