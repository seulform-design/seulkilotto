"""Walk-Forward 백테스트 시뮬레이터.

회차 R 시점에 [1..R-1] 만으로 학습한 추천이 실제 R 회차에서 몇 개 맞췄는지
시계열로 측정한다.

수학적 사실:
  - 독립시행 정의상 모든 전략의 기댓값은 6 × 6/45 = 0.8 개로 수렴한다.
  - 이는 알고리즘의 한계가 아니라 게임의 본질이다.
  - 본 백테스트의 진정한 가치는 '어떤 전략이 베이스라인을 의미 있게 이기지
    않는다' 는 정직한 사실을 시각적으로 입증하는 데 있다.

전략 비교:
  - uniform:    pure 무작위 (베이스라인)
  - frequency:  최근 lookback 회 빈도 가중 (hot/cold bonus 적용)
  - epo:        EPO 필터 파이프라인 (느림, 옵트인)
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd

from . import database
from .epo import EpoConfig
from .epo import run as run_epo
from .epo.weights import compute_weights

Strategy = Literal["uniform", "frequency", "epo", "composite"]

NUMBERS = np.arange(1, 46, dtype=int)
BASELINE_AVG_HITS: float = 6.0 * 6.0 / 45.0  # ≈ 0.8

DISCLAIMER: str = (
    "Walk-forward 백테스트는 각 회차 시점에서 직전 회차들만으로 학습한 추천이 "
    "다음 회차에 몇 개 맞췄는지를 시계열로 측정합니다. "
    "독립시행 정의상 모든 전략의 평균은 베이스라인 0.8개에 수렴합니다. "
    "이는 알고리즘의 부족이 아니라 게임의 수학적 본질입니다."
)


@dataclass
class StrategyResult:
    strategy: Strategy
    rounds_tested: int
    sets_generated: int
    avg_hits_per_set: float
    hit_distribution: dict[int, int]
    cumulative_avg: list[float]
    rounds_axis: list[int]
    hit_rate_3plus: float  # 5등 이상 적중
    hit_rate_4plus: float  # 4등 이상
    hit_rate_5plus: float  # 3등 이상
    hit_rate_6: float      # 1등
    # 무작위 기준선 대비 판정 (평균 적중 z-검정)
    delta_vs_baseline: float  # 평균 적중 - 무작위 기대(0.8)
    z_score: float            # (delta) / 표준오차
    beats_baseline: bool      # z>=2 이고 delta>0 이어야 '우위'


@dataclass
class WalkForwardSummary:
    start_round: int
    end_round: int
    rounds_evaluated: int
    sets_per_round: int
    baseline_avg_hits: float
    strategies: list[StrategyResult] = field(default_factory=list)
    disclaimer: str = DISCLAIMER


def _gen_uniform(rng: np.random.Generator, n_sets: int) -> list[tuple[int, ...]]:
    sets: list[tuple[int, ...]] = []
    for _ in range(n_sets):
        pick = rng.choice(NUMBERS, size=6, replace=False)
        sets.append(tuple(int(x) for x in sorted(pick)))
    return sets


def _gen_frequency(
    rng: np.random.Generator,
    n_sets: int,
    train_df: pd.DataFrame,
    lookback: int = 20,
) -> list[tuple[int, ...]]:
    weights = compute_weights(train_df, lookback=lookback, hot_bonus=0.10, cold_bonus=0.10)
    sets: list[tuple[int, ...]] = []
    for _ in range(n_sets):
        pick = rng.choice(NUMBERS, size=6, replace=False, p=weights)
        sets.append(tuple(int(x) for x in sorted(pick)))
    return sets


def _gen_epo(
    train_df: pd.DataFrame,
    n_sets: int,
    seed: int,
) -> list[tuple[int, ...]]:
    cfg = EpoConfig(
        n_sets=n_sets,
        lookback=20,
        cold_bonus=0.10,
        max_last_round_overlap=3,  # 너무 엄격하면 fallback 빈발
        enable_backtest=False,
        seed=seed,
    )
    res = run_epo(train_df, cfg)
    return [tuple(c["numbers"]) for c in res.combinations]


def _gen_composite(
    rng: np.random.Generator,
    n_sets: int,
    train_df: pd.DataFrame,
) -> list[tuple[int, ...]]:
    """합성 전략 — 종합 분석 페이지의 백테스트 가능 버전.

    실제 종합 분석은 3개 신호 (machine + post + photo) 를 합치지만,
    walk-forward 시점에서 photo 신호는 없으므로 (사용자 입력 의존)
    여기서는 2개 신호를 시뮬레이션:

      Signal 1 (machine 대용): 최근 30회 hot top 5
      Signal 2 (post 대용):    전체 train 의 누적 top 10

    각 번호의 신호 카운트로 가중치 계산 (1 + score) 후 정규화.
    EPO 와 달리 필터 단계 생략 (UI 의 composite 생성과 동일 정책).

    수학적 정직: 신호 가중치는 당첨 확률에 영향 없음.
    """
    if train_df.empty:
        return _gen_uniform(rng, n_sets)

    # Signal 1: 최근 30회 hot top 5
    recent_30 = train_df.sort_values("round", ascending=False).head(30)
    flat_recent = (
        recent_30[database.NUMBER_COLUMNS].to_numpy(dtype=int).ravel()
        if not recent_30.empty
        else np.array([], dtype=int)
    )
    recent_counts = np.zeros(45, dtype=int)
    for n in flat_recent:
        if 1 <= n <= 45:
            recent_counts[n - 1] += 1
    hot_top5_idx = np.argsort(-recent_counts)[:5]

    # Signal 2: 전체 train 의 누적 top 10
    flat_all = train_df[database.NUMBER_COLUMNS].to_numpy(dtype=int).ravel()
    all_counts = np.zeros(45, dtype=int)
    for n in flat_all:
        if 1 <= n <= 45:
            all_counts[n - 1] += 1
    grade_s_idx = np.argsort(-all_counts)[:10]

    # 신호 점수: 0/1/2 합산
    score = np.zeros(45, dtype=float)
    for i in hot_top5_idx:
        score[i] += 1.0
    for i in grade_s_idx:
        score[i] += 1.0

    # 가중치 = (1 + score) 정규화 — 0점도 약간의 확률 보장
    weights = 1.0 + score
    weights /= weights.sum()

    sets: list[tuple[int, ...]] = []
    for _ in range(n_sets):
        pick = rng.choice(NUMBERS, size=6, replace=False, p=weights)
        sets.append(tuple(int(x) for x in sorted(pick)))
    return sets


def _run_strategy(
    strategy: Strategy,
    target_rounds: list[int],
    df: pd.DataFrame,
    sets_per_round: int,
    seed: int,
) -> StrategyResult | None:
    rng = np.random.default_rng(seed)
    dist: Counter = Counter()
    cum_total = 0
    cum_sets = 0
    cum_avg: list[float] = []
    rounds_axis: list[int] = []

    for r in target_rounds:
        train = df[df["round"] < r]
        actual_rows = df[df["round"] == r]
        if actual_rows.empty:
            continue
        actual_nums = {
            int(actual_rows.iloc[0][c]) for c in database.NUMBER_COLUMNS
        }

        if strategy == "uniform":
            sets = _gen_uniform(rng, sets_per_round)
        elif strategy == "frequency":
            sets = _gen_frequency(rng, sets_per_round, train)
        elif strategy == "epo":
            # EPO 는 자체 seed 로 회차마다 다른 시드 사용
            sets = _gen_epo(train, sets_per_round, seed=int(r) ^ seed)
        elif strategy == "composite":
            sets = _gen_composite(rng, sets_per_round, train)
        else:
            return None

        for s in sets:
            hits = len(set(s) & actual_nums)
            dist[hits] += 1
            cum_total += hits
            cum_sets += 1

        if cum_sets > 0:
            cum_avg.append(cum_total / cum_sets)
            rounds_axis.append(int(r))

    total = sum(dist.values())
    if total == 0:
        return None

    # 무작위 기준선(0.8개) 대비 통계 판정 — 평균 적중의 z-검정.
    # 표본분산으로 평균의 표준오차를 구하고, (평균-기준)/SE 로 z 를 계산.
    mean = cum_total / total
    var = sum(((h - mean) ** 2) * c for h, c in dist.items()) / total
    se = (var / total) ** 0.5 if total > 0 else 0.0
    delta = mean - BASELINE_AVG_HITS
    z = round(delta / se, 2) if se > 0 else 0.0
    beats = bool(z >= 2.0 and delta > 0)

    return StrategyResult(
        strategy=strategy,
        rounds_tested=len(rounds_axis),
        sets_generated=total,
        avg_hits_per_set=cum_total / cum_sets if cum_sets else 0.0,
        hit_distribution=dict(dist),
        cumulative_avg=cum_avg,
        rounds_axis=rounds_axis,
        hit_rate_3plus=sum(dist[h] for h in range(3, 7)) / total,
        hit_rate_4plus=sum(dist[h] for h in range(4, 7)) / total,
        hit_rate_5plus=sum(dist[h] for h in range(5, 7)) / total,
        hit_rate_6=dist.get(6, 0) / total,
        delta_vs_baseline=round(delta, 4),
        z_score=z,
        beats_baseline=beats,
    )


def walk_forward(
    df: pd.DataFrame,
    start_round: int = 1128,
    end_round: int | None = None,
    sets_per_round: int = 5,
    seed: int = 42,
    strategies: tuple[Strategy, ...] = ("uniform", "frequency"),
) -> WalkForwardSummary:
    """전체 회차 DataFrame 으로부터 walk-forward 백테스트 실행."""
    if df is None or df.empty:
        return WalkForwardSummary(
            start_round=start_round,
            end_round=end_round or 0,
            rounds_evaluated=0,
            sets_per_round=sets_per_round,
            baseline_avg_hits=BASELINE_AVG_HITS,
            strategies=[],
        )

    available_rounds = sorted(df["round"].unique().tolist())
    max_round = int(available_rounds[-1])
    actual_end = max_round if end_round is None else min(int(end_round), max_round)
    actual_start = max(int(start_round), int(available_rounds[0]) + 1)

    target_rounds = [int(r) for r in available_rounds if actual_start <= r <= actual_end]

    results: list[StrategyResult] = []
    for strategy in strategies:
        res = _run_strategy(strategy, target_rounds, df, sets_per_round, seed)
        if res:
            results.append(res)

    return WalkForwardSummary(
        start_round=actual_start,
        end_round=actual_end,
        rounds_evaluated=len(target_rounds),
        sets_per_round=sets_per_round,
        baseline_avg_hits=BASELINE_AVG_HITS,
        strategies=results,
    )
