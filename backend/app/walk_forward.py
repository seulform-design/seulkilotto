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

Strategy = Literal["uniform", "frequency", "epo"]

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
