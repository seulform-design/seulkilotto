"""후속출현 패턴 분석 API."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException, Query

from ..database import load_history
from ..json_utils import to_jsonable
from ..post_occurrence_engine import run_post_occurrence_analysis

router = APIRouter(prefix="/api/v1/post-occurrence", tags=["post-occurrence"])


@router.get("/analysis")
def post_occurrence_analysis(
    round_no: int | None = Query(default=None, description="분석 기준 회차 (미입력 시 최신)"),
    numbers: str | None = Query(
        default=None,
        description="쉼표 구분 6개 번호 (미입력 시 해당 회차 당첨번호)",
    ),
    bonus: int | None = Query(default=None, ge=1, le=45),
):
    """직전 회차 조합의 과거 후속출현 패턴 기반 19단계 통계 분석."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")

    trigger_numbers: List[int] | None = None
    if numbers:
        try:
            trigger_numbers = sorted({int(x.strip()) for x in numbers.split(",")})
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="numbers 형식 오류") from exc
        if len(trigger_numbers) != 6:
            raise HTTPException(status_code=400, detail="번호 6개를 입력하세요.")

    result = run_post_occurrence_analysis(
        df,
        trigger_round=round_no,
        trigger_numbers=trigger_numbers,
        trigger_bonus=bonus,
    )
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return to_jsonable(result)
