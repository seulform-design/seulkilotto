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
    target_round: Optional[int] = Query(
        default=None,
        description="대상 회차. 복기=추첨 회차, 이번회차=미추첨 회차. 생략 시 intent 기본값.",
    ),
):
    """추첨기·후속출현·클래식·용지 intent 슬라이스를 규칙 기반으로 통합.

    복기/이번회차는 대상 회차·호기가 분리된다(예: 복기 1234·1호기 / 이번회차 1235·2호기).
    """
    out = build_prediction_signals(intent=intent, seed=seed, target_round=target_round)
    if out.get("error"):
        raise HTTPException(status_code=404, detail=out["error"])
    return to_jsonable(out)
