"""당첨 이력 조회 (/api/v1/history)."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..data_meta import effective_current_round
from ..database import get_last_data_source, load_history

router = APIRouter(prefix="/api/v1/history", tags=["history"])


def _row_to_draw(row) -> dict:
    return {
        "round": int(row["round"]),
        "draw_date": str(row["draw_date"])[:10],
        "numbers": [int(row[f"num{i}"]) for i in range(1, 7)],
        "bonus": int(row["bonus"]),
    }


@router.get("/latest")
def get_latest_draw():
    """CSV/DB 에서 최신 추첨 완료 회차 당첨 번호를 반환한다."""
    df = load_history()
    if df.empty:
        raise HTTPException(
            status_code=404,
            detail="당첨 데이터가 없습니다. 데이터 업그레이드를 실행해 주세요.",
        )

    row = df.sort_values("round", ascending=False).iloc[0]
    latest = int(row["round"])
    current = effective_current_round(latest)
    return {
        **_row_to_draw(row),
        "current_round": current,
        "next_round": current,
        "data_source": get_last_data_source(),
    }


@router.get("/rounds")
def list_rounds(
    limit: int = Query(default=50, ge=1, le=1500),
    offset: int = Query(default=0, ge=0),
):
    """회차 목록 (최신순)."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")

    ordered = df.sort_values("round", ascending=False)
    total = len(ordered)
    slice_df = ordered.iloc[offset : offset + limit]
    items: List[dict] = [_row_to_draw(row) for _, row in slice_df.iterrows()]
    return {"total": total, "offset": offset, "limit": limit, "items": items}


@router.get("/{round_no}")
def get_round(round_no: int):
    """특정 회차 당첨 번호."""
    if round_no < 1:
        raise HTTPException(status_code=400, detail="유효하지 않은 회차입니다.")

    df = load_history()
    match = df[df["round"].astype(int) == round_no]
    if match.empty:
        raise HTTPException(status_code=404, detail=f"{round_no}회 데이터가 없습니다.")

    return _row_to_draw(match.iloc[0])
