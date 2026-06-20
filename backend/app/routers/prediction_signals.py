"""통합 예측 신호 API."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..json_utils import to_jsonable
from ..prediction_signals import build_prediction_signals

router = APIRouter(prefix="/api/v1/prediction", tags=["prediction"])


@router.get("/signals")
def get_prediction_signals(
    intent: str = Query(default="current_round", description="review | current_round"),
    seed: Optional[int] = Query(default=None),
):
    """추첨기·후속출현·클래식·용지 intent 슬라이스를 규칙 기반으로 통합."""
    out = build_prediction_signals(intent=intent, seed=seed)
    if out.get("error"):
        raise HTTPException(status_code=404, detail=out["error"])
    return to_jsonable(out)
