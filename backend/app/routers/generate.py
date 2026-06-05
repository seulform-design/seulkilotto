"""번호 생성 엔드포인트 (/api/v1/generate).

[기획서 API 3] GET /api/v1/generate/weights
- 최근 lookback(기본 5회) 미출현 번호에 settings.UNSEEN_WEIGHT_BONUS(+15%) 가산
- np.random.choice 비복원 추출로 6개 번호 1조합 생성 (n_sets 로 여러 게임 가능)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import analytics
from ..config import settings
from ..database import load_history
from ..schemas import GenerateResponse

router = APIRouter(prefix="/api/v1/generate", tags=["generate"])


@router.get("/weights", response_model=GenerateResponse)
def generate_weighted(
    n_sets: int = Query(default=1, ge=1, le=20, description="생성할 추천 조합 수 (기본 1조합)"),
    lookback: int = Query(
        default=settings.UNSEEN_LOOKBACK_DRAWS,
        ge=1,
        description="미출현 번호를 판단할 최근 회차 수 (기본 5주)",
    ),
    exclude_consecutive: bool = Query(
        default=False, description="연속 번호가 포함된 조합 제외 여부"
    ),
    seed: int | None = Query(default=None, description="재현용 랜덤 시드(선택)"),
):
    """최근 N주 미출현 번호에 +15% 가중치를 부여한 통계 기반 추천 조합을 생성한다."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    return analytics.generate_weighted_sets(
        df,
        n_sets=n_sets,
        unseen_bonus=settings.UNSEEN_WEIGHT_BONUS,  # 0.15 (=15%)
        lookback=lookback,
        exclude_consecutive=exclude_consecutive,
        seed=seed,
    )
