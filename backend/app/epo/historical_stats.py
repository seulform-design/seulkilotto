"""역사적 1등 조합으로부터 경험적 분포(empirical distribution)를 산출.

본 모듈은 '예측'을 하지 않는다. 단지 과거 1등 조합들이
어떤 분포 특성을 가졌는지를 측정한다. 이 측정값은 필터의 기본 파라미터
(예: 합계 허용 구간, AC 임계값, 홀짝 허용 비율)를 결정하는 데 사용된다.

핵심 통계:
  - 합계 백분위수 (1%, 10%, 50%, 90%, 99%)
  - 홀수 개수 / 고번호 개수의 분포 빈도
  - AC 값의 평균 및 10% 백분위수
  - 연속 길이의 95% 백분위수
  - 직전 회차 번호 (last-round overlap 필터의 기준)
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import database
from . import filters


@dataclass
class HistoricalProfile:
    """경험적 분포 프로필. 모든 값은 1등 조합 N회 관측 기반."""

    rounds_analyzed: int
    sum_p01: int
    sum_p10: int
    sum_p50: int
    sum_p90: int
    sum_p99: int
    sum_mean: float
    odd_count_freq: dict[int, float]
    high_count_freq: dict[int, float]
    odd_count_modes: list[int]
    high_count_modes: list[int]
    avg_ac: float
    p10_ac: int
    max_run_p95: int
    last_round_no: int | None
    last_round_combo: tuple[int, ...] = field(default_factory=tuple)


# 표본 부재 시 보수적 폴백 (한국 로또 6/45 의 이론적 범위 + 일반적 임계)
_FALLBACK = HistoricalProfile(
    rounds_analyzed=0,
    sum_p01=63,
    sum_p10=100,
    sum_p50=138,
    sum_p90=175,
    sum_p99=213,
    sum_mean=138.0,
    odd_count_freq={3: 0.32, 2: 0.24, 4: 0.24, 1: 0.10, 5: 0.08, 0: 0.01, 6: 0.01},
    high_count_freq={3: 0.32, 4: 0.24, 2: 0.24, 5: 0.10, 1: 0.08, 0: 0.01, 6: 0.01},
    odd_count_modes=[2, 3, 4],
    high_count_modes=[2, 3, 4],
    avg_ac=7.4,
    p10_ac=6,
    max_run_p95=2,
    last_round_no=None,
    last_round_combo=(),
)


def _safe_percentile(arr: np.ndarray, q: float, default: int) -> int:
    if arr.size == 0:
        return default
    return int(np.percentile(arr, q))


def compute_profile(df: pd.DataFrame, mode_threshold: float = 0.10) -> HistoricalProfile:
    """과거 회차 DataFrame 에서 통계 프로필을 계산한다.

    Args:
        df: round, num1..num6, bonus 컬럼을 가진 회차 데이터 (오름차순).
        mode_threshold: '주요 모드'로 인정할 빈도 비율 하한 (기본 10%).

    Returns:
        HistoricalProfile. df 가 비어 있으면 _FALLBACK 반환.
    """
    if df is None or df.empty:
        return _FALLBACK

    nums_arr = df[database.NUMBER_COLUMNS].to_numpy(dtype=int)  # (N, 6)
    if nums_arr.size == 0:
        return _FALLBACK

    sums = nums_arr.sum(axis=1)
    odd_counts = (nums_arr % 2 == 1).sum(axis=1)
    high_counts = (nums_arr >= filters.HIGH_THRESHOLD).sum(axis=1)

    # 행별 AC / max-run 은 순수파이썬 루프 (벡터화 어려움, N≈1200 이므로 OK)
    ac_vals = np.fromiter(
        (filters.ac_value(tuple(row)) for row in nums_arr),
        dtype=int,
        count=nums_arr.shape[0],
    )
    runs = np.fromiter(
        (filters.max_consecutive_run(tuple(row)) for row in nums_arr),
        dtype=int,
        count=nums_arr.shape[0],
    )

    odd_dist = pd.Series(odd_counts).value_counts(normalize=True).to_dict()
    high_dist = pd.Series(high_counts).value_counts(normalize=True).to_dict()

    odd_modes = sorted(int(k) for k, v in odd_dist.items() if v >= mode_threshold)
    high_modes = sorted(int(k) for k, v in high_dist.items() if v >= mode_threshold)

    # 안전망: 임계 이하라 모드가 비면 분포 상위 3개로 폴백
    if not odd_modes:
        odd_modes = sorted(int(k) for k in pd.Series(odd_counts).value_counts().head(3).index)
    if not high_modes:
        high_modes = sorted(int(k) for k in pd.Series(high_counts).value_counts().head(3).index)

    last_row = df.sort_values("round", ascending=False).iloc[0]
    last_combo = tuple(int(last_row[c]) for c in database.NUMBER_COLUMNS)
    last_no = int(last_row["round"])

    return HistoricalProfile(
        rounds_analyzed=int(len(df)),
        sum_p01=_safe_percentile(sums, 1, _FALLBACK.sum_p01),
        sum_p10=_safe_percentile(sums, 10, _FALLBACK.sum_p10),
        sum_p50=_safe_percentile(sums, 50, _FALLBACK.sum_p50),
        sum_p90=_safe_percentile(sums, 90, _FALLBACK.sum_p90),
        sum_p99=_safe_percentile(sums, 99, _FALLBACK.sum_p99),
        sum_mean=float(sums.mean()),
        odd_count_freq={int(k): float(v) for k, v in odd_dist.items()},
        high_count_freq={int(k): float(v) for k, v in high_dist.items()},
        odd_count_modes=odd_modes,
        high_count_modes=high_modes,
        avg_ac=float(ac_vals.mean()),
        p10_ac=int(np.percentile(ac_vals, 10)),
        max_run_p95=int(np.percentile(runs, 95)),
        last_round_no=last_no,
        last_round_combo=last_combo,
    )
