"""통계 관련 엔드포인트 (/api/v1/stats).

[기획서 API 1] GET /api/v1/stats/frequency
- 입력: optional recent_n (최근 N회차 슬라이스)
- 처리: Pandas value_counts on num1~num6 flattened vector
- 출력: total_rounds, items[{number, count, ratio}]
"""
from __future__ import annotations

from dataclasses import asdict

from pydantic import BaseModel, Field
from typing import List
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
                "delta_vs_baseline": s.delta_vs_baseline,
                "z_score": s.z_score,
                "beats_baseline": s.beats_baseline,
            }
            for s in summary.strategies
        ],
        "disclaimer": summary.disclaimer,
    }


@router.get("/full-history-backtest")
def get_full_history_backtest(warmup: int = Query(50, ge=10, le=500)):
    """전체 당첨 이력 워크포워드 백테스트 — 흔한 전략(핫·콜드·미출·최근·페어·회피)이
    무작위를 이기는지 수백~1200+ 회차로 검정한다. 각 회차는 이전 회차만으로 예측하고 그
    회차로 채점(누수 없음). 다중검정 보정(Bonferroni)으로 위양성을 걸러낸다.
    ⚠️ 로또 i.i.d. — 확률(1/8,145,060)은 어떤 전략으로도 불변.

    독립 회차 통계 엔진(`app.stats_engine.backtest`) 사용 — 용지(photo) 모듈 비의존.
    데이터 부족 시 200 + ok=false, 계산 오류 시 500 + 명확한 detail.
    """
    from ..json_utils import to_jsonable
    from ..stats_engine.backtest import build_full_history_backtest

    try:
        return to_jsonable(build_full_history_backtest(warmup=warmup))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"전체 이력 백테스트 계산 실패: {exc}") from exc


@router.get("/ticket-backtest")
def get_ticket_backtest(
    warmup: int = Query(50, ge=10, le=500),
    reps: int = Query(200, ge=10, le=1000, description="무작위 기준선 Monte Carlo 반복 수"),
):
    """6개 1장 단위 전체 이력 walk-forward — 일치 개수(0~6)·3/4/5/5+보너스/6 횟수, 기간별
    성능, 번호별 적중 빈도, 이론 초기하 분포·무작위 Monte Carlo 기준선 비교(다중검정 보정).
    ⚠️ 백테스트(kind=backtest)는 수학적 확률(kind=mathematical)과 다르며 미래 확률을 바꾸지 않는다."""
    from ..json_utils import to_jsonable
    from ..stats_engine.backtest import RANDOM_SEED, build_ticket_backtest

    try:
        return to_jsonable(build_ticket_backtest(warmup=warmup, reps=reps, seed=RANDOM_SEED))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"티켓 백테스트 계산 실패: {exc}") from exc


@router.get("/probability")
def get_probability(n: int = Query(1, ge=0, le=8_145_060, description="서로 다른 조합 수")):
    """수학적 기준값 — C(45,6)=8,145,060, 단일/서로 다른 n장 1등 확률, 일치 개수·등수 확률."""
    from ..stats_engine.probability import summary

    return summary(n)


class _TicketsBody(BaseModel):
    tickets: List[List[int]] = Field(..., max_length=10000)


@router.post("/probability/tickets")
def post_tickets_probability(body: _TicketsBody):
    """구매 조합 목록의 1등 확률 — 유효성(6개·1~45·중복 없음) 검사 후 중복 조합 제거, n/8,145,060."""
    from ..stats_engine.probability import tickets_probability

    return tickets_probability(body.tickets)


@router.get("/windows")
def get_window_stats():
    """표본 크기별(전체·최근 100/50/30/10회) 기술 통계 + 균등성 검정(카이제곱·효과크기)
    + 번호쌍 동시출현 + 다중비교 보정(Bonferroni·BH). 소표본(기대도수<5)은 유의성 미주장."""
    from ..json_utils import to_jsonable
    from ..stats_engine.windows import build_window_stats

    try:
        return to_jsonable(build_window_stats())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"윈도우 통계 계산 실패: {exc}") from exc


@router.get("/integrity")
def get_data_integrity():
    """회차 데이터 무결성 — 중복·누락 회차, 번호 범위, 본번호 중복, 보너스 오류,
    날짜 순서, 집계 합계(본번호 6×회차, 보너스 1×회차) 검증 + 데이터 시그니처."""
    from ..stats_engine import cache as stats_cache
    from ..stats_engine.draws import integrity_report

    out = integrity_report()
    out["cache"] = stats_cache.info()
    return out


@router.get("/snapshot")
def get_statistics_snapshot(
    recent_n: int | None = Query(
        default=None,
        ge=1,
        description="최근 N회차만 스냅샷. 생략 시 전체 이력.",
    ),
    include_carry: bool = Query(
        default=False,
        description="last_round carry 필드 포함(기본 제외 — 누수·의도 혼동 방지).",
    ),
    persist: bool = Query(
        default=False,
        description="True 이면 data/statistics_snapshots/ 에 누적 저장(삭제 없음).",
    ),
):
    """Statistics Artifact 0.1.0 — EPO HistoricalProfile 버전드 스냅샷.

    추천 점수에 연결하지 않는다. Explain·필터 기준선·재현용.
    """
    from ..epo.snapshot_store import persist_snapshot
    from ..epo.statistics_snapshot import SNAPSHOT_VERSION, build_snapshot_from_history

    df = load_history()
    if df.empty:
        snap = build_snapshot_from_history(None, include_carry=include_carry)
        snap["note"] = "당첨 데이터 없음 — FALLBACK 보수값"
    else:
        snap = build_snapshot_from_history(
            df, include_carry=include_carry, recent_n=recent_n
        )
    snap["api_version"] = SNAPSHOT_VERSION
    if persist:
        meta = persist_snapshot(snap, tag="api")
        snap["persist"] = meta
    return snap


@router.get("/snapshot/history")
def get_statistics_snapshot_history(
    limit: int = Query(default=30, ge=1, le=200),
):
    """누적 저장된 StatisticsSnapshot 목록(메타만). 점수 미연결."""
    from ..epo.snapshot_store import list_snapshots

    return list_snapshots(limit=limit)


@router.get("/snapshot/history/{filename}")
def get_statistics_snapshot_file(filename: str):
    """저장된 스냅샷 본문. 경로 탈출 방지."""
    from ..epo.snapshot_store import load_snapshot

    snap = load_snapshot(filename)
    if snap is None:
        raise HTTPException(status_code=404, detail="스냅샷 파일을 찾을 수 없습니다.")
    return snap
