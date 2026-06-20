"""평행회차 분석 API."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..database import load_history
from ..json_utils import to_jsonable
from ..parallel_round_analysis import analyze_parallel_rounds

router = APIRouter(prefix="/api/v1/analysis", tags=["analysis"])


@router.get("/parallel-round")
def get_parallel_round_analysis(
    target_round: Optional[int] = Query(
        default=None,
        ge=1,
        description="분석 대상 회차 (미입력 시 다음 회차)",
    ),
):
    """평행회차(동일 끝2자리) 당첨 패턴 — 평행강수·기대수·끝수."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    out = analyze_parallel_rounds(df, target_round=target_round)
    if out.get("error") and not out.get("draw_table"):
        raise HTTPException(status_code=404, detail=out["error"])
    return to_jsonable(out)
