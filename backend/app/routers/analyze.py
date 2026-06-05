"""조합 분석 엔드포인트 (/api/v1/analyze).

[기획서 API 2] POST /api/v1/analyze/combination
- Body: { "numbers": [int x 6] } — 1~45, 중복 불가 (Pydantic validator)
- 분석 항목: 홀짝 개수, 총합(sum_band: 낮음/보통/높음), 연속 쌍 목록
"""
from __future__ import annotations

from fastapi import APIRouter

from .. import analytics
from ..schemas import CombinationAnalysis, CombinationRequest

router = APIRouter(prefix="/api/v1/analyze", tags=["analyze"])


@router.post("/combination", response_model=CombinationAnalysis)
def analyze_combination(payload: CombinationRequest):
    """사용자가 입력한 6개 번호 조합의 홀짝/총합 구간/연속 번호 여부를 분석한다."""
    # payload.numbers: schemas.CombinationRequest 에서 범위·중복 검증 후 오름차순 정렬됨
    return analytics.analyze_combination(payload.numbers)
