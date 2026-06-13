"""통계 관련 엔드포인트 (/api/v1/stats).

[기획서 API 1] GET /api/v1/stats/frequency
- 입력: optional recent_n (최근 N회차 슬라이스)
- 처리: Pandas value_counts on num1~num6 flattened vector
- 출력: total_rounds, items[{number, count, ratio}]
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query

from .. import analytics, co_occurrence, temperature, walk_forward as wf
from ..database import load_history
from ..schemas import (
    CoOccurrenceResponse,
    FrequencyResponse,
    TemperatureResponse,
    WalkForwardResponse,
)

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


@router.get("/walk-forward", response_model=WalkForwardResponse)
def get_walk_forward(
    start_round: int = Query(default=1128, ge=10, description="시뮬레이션 시작 회차"),
    end_round: int | None = Query(default=None, description="종료 회차 (생략 시 최신)"),
    sets_per_round: int = Query(default=5, ge=1, le=20),
    include_epo: bool = Query(default=False, description="EPO 전략 포함 (느림)"),
    include_composite: bool = Query(
        default=False,
        description="종합 분석 전략 포함 (machine+post 신호 합성 — 빠름)",
    ),
    seed: int = Query(default=42, description="재현성 시드"),
):
    """Walk-Forward 백테스트 — 회차 R 시점에 [1..R-1] 로 학습한 추천이
    실제 R 에서 몇 개 맞췄는지 시계열로 측정한다.

    수학적 정직 선언:
      - 독립시행 정의상 모든 전략의 평균 적중은 베이스라인 0.8 개에 수렴.
      - 본 백테스트의 가치는 '어떤 전략도 베이스라인을 의미 있게 이기지 않는다'
        는 정직한 사실을 시각적으로 입증하는 것.
    """
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")

    strategies: tuple[wf.Strategy, ...] = ("uniform", "frequency")
    if include_composite:
        strategies = (*strategies, "composite")
    if include_epo:
        strategies = (*strategies, "epo")

    summary = wf.walk_forward(
        df,
        start_round=start_round,
        end_round=end_round,
        sets_per_round=sets_per_round,
        seed=seed,
        strategies=strategies,
    )

    return {
        "start_round": summary.start_round,
        "end_round": summary.end_round,
        "rounds_evaluated": summary.rounds_evaluated,
        "sets_per_round": summary.sets_per_round,
        "baseline_avg_hits": summary.baseline_avg_hits,
        "strategies": [
            {
                "strategy": s.strategy,
                "rounds_tested": s.rounds_tested,
                "sets_generated": s.sets_generated,
                "avg_hits_per_set": s.avg_hits_per_set,
                "hit_distribution": {str(k): v for k, v in s.hit_distribution.items()},
                "cumulative_avg": s.cumulative_avg,
                "rounds_axis": s.rounds_axis,
                "hit_rate_3plus": s.hit_rate_3plus,
                "hit_rate_4plus": s.hit_rate_4plus,
                "hit_rate_5plus": s.hit_rate_5plus,
                "hit_rate_6": s.hit_rate_6,
            }
            for s in summary.strategies
        ],
        "disclaimer": summary.disclaimer,
    }
