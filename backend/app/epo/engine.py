"""EPO 메인 엔진 — Multi-Stage Filter Pipeline + 자기 검증 통합.

본 모듈은 입력 회차 DataFrame 과 EpoConfig 를 받아
(1) 백테스트로 필터 셋의 자기 검증을 먼저 수행하고
(2) 합격 시 EPO 필터 적용, 불합격 시 Fallback (느슨한 필터) 로 전환한 뒤
(3) 다양성 보장된 N 개 조합을 산출한다.

수학적 사실(절대 변경 금지):
  - 어떤 필터/가중치를 적용해도 당첨 확률(1/8,145,060) 은 변하지 않는다.
  - 본 엔진의 목표는 '경험적으로 그럴듯한 분포'의 조합을 선별하여
    당첨 시 분배 인원을 줄이는 것 (Expected Payout Optimization).
  - 자기 검증(backtest) 이 fail 하면 EPO 를 비활성화하고 명시한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import filters as F
from .backtest import BacktestResult, evaluate_filters, loose_fallback_predicates
from .historical_stats import HistoricalProfile, compute_profile
from .pipeline import candidate_stream, filter_stream, take_diverse
from .weights import classify_numbers, compute_weights, recent_counts

ENGINE_VERSION: str = "EPO_v1_Advanced"
WIN_PROBABILITY_PER_SET: float = 1.0 / 8_145_060.0

DISCLAIMER: str = (
    "본 조합은 과거 통계 패턴 분석 결과일 뿐이며, "
    "수학적 독립시행인 로또의 당첨 확률 자체를 물리적으로 상승시키지 않습니다."
)
OPTIMIZATION_TARGET: str = (
    "당첨 시 기대 상금 분산 최적화 및 극단적 조합(예: 1,2,3,4,5,6) 배제"
)


@dataclass
class EpoConfig:
    """EPO 엔진 입력 파라미터."""

    n_sets: int = 5
    lookback: int = 10
    hot_bonus: float = 0.0
    cold_bonus: float = 0.15

    # 필터 임계값 — None 이면 historical profile 에서 자동 결정
    sum_min: int | None = None
    sum_max: int | None = None
    odd_count_allowed: tuple[int, ...] | None = None
    high_count_allowed: tuple[int, ...] | None = None
    max_consecutive_run: int = 2
    min_ac_value: int = 7
    max_same_decade: int = 3
    min_last_digit_unique: int = 3
    max_last_round_overlap: int = 1

    inter_set_max_overlap: int = 3
    seed: int | None = None
    max_attempts: int = 200_000

    # 자기 검증
    enable_backtest: bool = True
    backtest_holdout: int = 200
    backtest_threshold: float = 0.50


@dataclass
class EpoResult:
    """EPO 실행 결과 — engine.run() 의 단일 반환 객체."""

    profile: HistoricalProfile
    combinations: list[dict] = field(default_factory=list)
    weights_meta: dict = field(default_factory=dict)
    pipeline_meta: dict = field(default_factory=dict)
    backtest_meta: dict = field(default_factory=dict)
    honesty: dict = field(default_factory=dict)
    engine: str = ENGINE_VERSION


def _resolve_predicates(
    config: EpoConfig,
    profile: HistoricalProfile,
) -> tuple[list[F.Predicate], list[str], tuple[int, int]]:
    """config + profile 로부터 활성 predicate 리스트와 라벨, 합계 구간 결정."""
    sum_lo = config.sum_min if config.sum_min is not None else profile.sum_p10
    sum_hi = config.sum_max if config.sum_max is not None else profile.sum_p90

    odd_allowed = (
        set(config.odd_count_allowed)
        if config.odd_count_allowed is not None
        else set(profile.odd_count_modes)
    )
    high_allowed = (
        set(config.high_count_allowed)
        if config.high_count_allowed is not None
        else set(profile.high_count_modes)
    )

    if not odd_allowed:
        odd_allowed = {2, 3, 4}
    if not high_allowed:
        high_allowed = {2, 3, 4}

    predicates: list[F.Predicate] = [
        F.passes_sum_range(sum_lo, sum_hi),
        F.passes_min_ac(config.min_ac_value),
        F.passes_odd_count(odd_allowed),
        F.passes_high_count(high_allowed),
        F.passes_max_run(config.max_consecutive_run),
        F.passes_decade_balance(config.max_same_decade),
        F.passes_last_digit_variety(config.min_last_digit_unique),
    ]
    labels: list[str] = [
        f"sum_range[{sum_lo}~{sum_hi}]",
        f"ac_value>={config.min_ac_value}",
        f"odd_count in {sorted(odd_allowed)}",
        f"high_count(>={F.HIGH_THRESHOLD}) in {sorted(high_allowed)}",
        f"max_consecutive_run<={config.max_consecutive_run}",
        f"max_same_decade<={config.max_same_decade}",
        f"last_digit_unique>={config.min_last_digit_unique}",
    ]

    if profile.last_round_combo:
        predicates.append(
            F.passes_last_round_overlap(profile.last_round_combo, config.max_last_round_overlap)
        )
        labels.append(
            f"last_round_overlap<={config.max_last_round_overlap}"
            f" (vs round {profile.last_round_no})"
        )

    return predicates, labels, (sum_lo, sum_hi)


def _annotate(combo: tuple[int, ...], last: tuple[int, ...]) -> dict:
    """단일 조합의 모든 메트릭을 한 번에 산출."""
    return {
        "numbers": list(combo),
        "sum_total": F.sum_total(combo),
        "odd_count": F.odd_count(combo),
        "even_count": F.even_count(combo),
        "high_count": F.high_count(combo),
        "low_count": 6 - F.high_count(combo),
        "ac_value": F.ac_value(combo),
        "max_consecutive_run": F.max_consecutive_run(combo),
        "max_same_decade": F.max_same_decade(combo),
        "last_digit_unique": F.last_digit_unique(combo),
        "decade_distribution": F.decade_buckets(combo),
        "last_round_overlap": F.overlap_count(combo, last),
    }


def _backtest_meta(result: BacktestResult, filter_labels: list[str]) -> dict:
    return {
        "epo_enabled": result.epo_enabled,
        "fallback_active": not result.epo_enabled,
        "historical_pass_rate": round(result.historical_pass_rate, 4),
        "pass_threshold": result.pass_threshold,
        "sample_size": result.sample_size,
        "passed_count": result.passed_count,
        "baseline_avg_hit_count": round(result.baseline_avg_hit, 4),
        "reason": result.reason,
        "filters_validated": filter_labels,
        "p_value_validation": result.epo_enabled,
    }


def run(df: pd.DataFrame, config: EpoConfig) -> EpoResult:
    """EPO 파이프라인 실행.

    단계:
      1. 역사적 프로필 계산
      2. 가중치 산출
      3. 사용자 설정 predicate 구성
      4. (선택) 백테스트 자기 검증
         - 합격 → EPO 활성
         - 불합격 → Fallback 활성 (느슨한 필터)
      5. 후보 스트림 → 필터 → 다양성 선택
      6. 메트릭 부여 + honesty meta 부착
    """
    profile = compute_profile(df)
    epo_predicates, epo_labels, (sum_lo, sum_hi) = _resolve_predicates(config, profile)

    # ── 자기 검증 ──────────────────────────────────────────
    if config.enable_backtest:
        bt = evaluate_filters(
            df,
            epo_predicates,
            holdout=config.backtest_holdout,
            pass_threshold=config.backtest_threshold,
        )
    else:
        bt = BacktestResult(
            sample_size=0,
            passed_count=0,
            historical_pass_rate=1.0,
            pass_threshold=config.backtest_threshold,
            epo_enabled=True,
            baseline_avg_hit=6.0 * 6.0 / 45.0,
            reason="백테스트 비활성 — 사용자 설정대로 EPO 활성",
        )

    if bt.epo_enabled:
        predicates = epo_predicates
        labels = epo_labels
        active_mode = "epo"
    else:
        # Fallback: 느슨한 필터만 적용 (1,2,3,4,5,6 등 극단 패턴은 여전히 배제)
        fb_preds, fb_labels = loose_fallback_predicates()
        predicates = fb_preds
        labels = fb_labels
        active_mode = "fallback"

    # ── 파이프라인 실행 ────────────────────────────────────
    rng = np.random.default_rng(config.seed)
    weights = compute_weights(
        df,
        lookback=config.lookback,
        hot_bonus=config.hot_bonus,
        cold_bonus=config.cold_bonus,
    )

    stream = candidate_stream(rng, weights)
    filtered = filter_stream(stream, predicates)
    selected, attempts = take_diverse(
        filtered,
        n=config.n_sets,
        max_overlap=config.inter_set_max_overlap,
        max_attempts=config.max_attempts,
    )

    combos = [_annotate(c, profile.last_round_combo) for c in selected]

    counts_vec = recent_counts(df, config.lookback)
    hot_nums, cold_nums = classify_numbers(counts_vec)

    weights_meta = {
        "lookback_rounds": config.lookback,
        "hot_bonus": config.hot_bonus,
        "cold_bonus": config.cold_bonus,
        "hot_numbers": hot_nums,
        "cold_numbers": cold_nums,
        "weight_uniform": bool(config.hot_bonus == 0 and config.cold_bonus == 0),
    }

    pipeline_meta = {
        "active_mode": active_mode,
        "candidates_attempted": attempts,
        "combinations_returned": len(combos),
        "combinations_requested": config.n_sets,
        "max_attempts_cap": config.max_attempts,
        "filters_applied": labels,
        "sum_range_applied": [sum_lo, sum_hi] if active_mode == "epo" else None,
        "diversity_max_overlap": config.inter_set_max_overlap,
        "shortfall_warning": (
            f"요청 {config.n_sets}개 중 {len(combos)}개만 생성. "
            "필터 조건이 과도하게 엄격하거나 max_attempts 초과."
            if len(combos) < config.n_sets
            else None
        ),
    }

    backtest_meta = _backtest_meta(bt, epo_labels)

    honesty = {
        "win_probability_per_set": WIN_PROBABILITY_PER_SET,
        "win_probability_unchanged": True,
        "optimization_target": OPTIMIZATION_TARGET,
        "disclaimer": DISCLAIMER,
    }

    return EpoResult(
        profile=profile,
        combinations=combos,
        weights_meta=weights_meta,
        pipeline_meta=pipeline_meta,
        backtest_meta=backtest_meta,
        honesty=honesty,
        engine=ENGINE_VERSION,
    )
