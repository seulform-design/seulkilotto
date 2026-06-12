"""통계 관련 엔드포인트 (/api/v1/stats).

[기획서 API 1] GET /api/v1/stats/frequency
- 입력: optional recent_n (최근 N회차 슬라이스)
- 처리: Pandas value_counts on num1~num6 flattened vector
- 출력: total_rounds, items[{number, count, ratio}]
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query

from .. import analytics, co_occurrence, temperature
from ..database import load_history
from ..schemas import CoOccurrenceResponse, FrequencyResponse, TemperatureResponse

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])


@router.get("/frequency", response_model=FrequencyResponse)
def get_frequency(
    recent_n: int | None = Query(
        default=None,
        ge=1,
        description="최근 N회차만 집계. 생략 시 전체 회차 집계.",
    ),
):
    """전체 또는 최근 N회차 동안의 1~45번 번호별 출현 빈도수 및 비율을 반환한다."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    return analytics.calc_frequency(df, recent_n=recent_n)


@router.get("/temperature", response_model=TemperatureResponse)
def get_temperature(
    lookback: int = Query(
        default=temperature.DEFAULT_LOOKBACK,
        ge=1,
        le=500,
        description="최근 N회차를 핫/콜드 측정 윈도우로 사용 (기본 30).",
    ),
):
    """1~45 번호 각각에 5단계 온도 등급(Hot/Warm/Neutral/Cold/Frozen)을 부여한다.

    수학적 정직 선언:
      - 등급은 과거 분포의 메타포일 뿐, 다음 회차 출현 확률(=6/45)에 영향 없음.
      - 백분위 기반 분류 — 각 등급 정확히 9개로 균등 분배.
    """
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    summary = temperature.compute_temperature(df, lookback=lookback)
    return {
        "lookback": summary.lookback,
        "latest_round": summary.latest_round,
        "total_rounds": summary.total_rounds,
        "items": [asdict(it) for it in summary.items],
        "tier_distribution": summary.tier_distribution,
        "tier_labels": summary.tier_labels,
        "tier_colors": summary.tier_colors,
        "disclaimer": summary.disclaimer,
    }


@router.get("/co-occurrence", response_model=CoOccurrenceResponse)
def get_co_occurrence(
    top_n: int = Query(
        default=co_occurrence.DEFAULT_TOP_N,
        ge=1,
        le=44,
        description="각 번호당 상위 N개 동반 번호 (기본 20).",
    ),
):
    """각 번호 1~45 의 동반 출현 통계를 반환한다.

    각 Partner 에 대해 count / confidence / lift / is_significant 4종 메트릭 노출.
    무작위 베이스라인(≈ 11.4%) 과 비교할 수 있도록 baseline_confidence 도 동봉.

    수학적 정직 선언:
      - 본 통계는 과거 분포의 묘사일 뿐, 다음 회차 확률에 영향 없음.
      - lift > 1.2 + count >= 30 인 쌍에만 is_significant = true (보수적 기준).
    """
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    summary = co_occurrence.compute_co_occurrence(df, top_n=top_n)
    return {
        "total_rounds": summary.total_rounds,
        "appearance_counts": {str(k): v for k, v in summary.appearance_counts.items()},
        "baseline_confidence": summary.baseline_confidence,
        "top_n": summary.top_n,
        "partners": {
            str(src): [asdict(p) for p in plist]
            for src, plist in summary.partners.items()
        },
        "disclaimer": summary.disclaimer,
    }
