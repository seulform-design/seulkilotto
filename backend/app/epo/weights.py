"""동적 핫/콜드 가중치.

본 모듈은 균등 분포(1/45) 에 사용자 파라미터(hot_bonus, cold_bonus)로
편향(bias)을 가산한다. 통계적으로 이 편향은 당첨 확률에 영향을 주지
않는다 (도박사의 오류). 다만 사용자가 원하는 패턴(예: 최근 안 나온
번호 선호) 을 후보 분포에 반영하는 UX 레버로 작용한다.

설계 결정:
  - bonus 가 0 이면 정확한 균등 분포 반환 (수학적 중립 보장)
  - bonus 가 양수면 가중치 후 정규화 (sum == 1)
  - 핫/콜드 동시 적용 가능 (서로 다른 번호 집합에 적용됨)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import database

ALL_NUMBERS = np.arange(1, 46, dtype=int)
NUMBER_COUNT = 45


def recent_counts(df: pd.DataFrame, lookback: int) -> np.ndarray:
    """최근 lookback 회차 동안의 1~45 번호별 출현 횟수 벡터(길이 45).

    df 가 비거나 lookback <= 0 이면 모두 0 인 벡터 반환.
    """
    counts = np.zeros(NUMBER_COUNT, dtype=int)
    if df is None or df.empty or lookback <= 0:
        return counts

    recent = df.sort_values("round", ascending=False).head(lookback)
    flat = recent[database.NUMBER_COLUMNS].to_numpy(dtype=int).ravel()
    for n in flat:
        if 1 <= n <= NUMBER_COUNT:
            counts[n - 1] += 1
    return counts


def compute_weights(
    df: pd.DataFrame,
    lookback: int,
    hot_bonus: float = 0.0,
    cold_bonus: float = 0.0,
    hot_percentile: float = 80.0,
) -> np.ndarray:
    """45개 번호 각각에 정규화된 가중치(합=1) 를 반환.

    Args:
        df: 회차 데이터.
        lookback: 최근 N 회차 (가중치 산정 윈도우).
        hot_bonus: 핫 넘버에 가산할 비중 (0.0 ~ 0.5 권장).
        cold_bonus: 콜드 넘버(미출현)에 가산할 비중.
        hot_percentile: 핫 판정 임계 (기본 상위 20%).

    Returns:
        shape=(45,) 정규화된 확률 벡터.
    """
    base = np.ones(NUMBER_COUNT, dtype=float)

    if (hot_bonus <= 0.0 and cold_bonus <= 0.0) or df is None or df.empty or lookback <= 0:
        return base / base.sum()

    counts = recent_counts(df, lookback)

    if cold_bonus > 0.0:
        cold_mask = counts == 0
        if cold_mask.any():
            base[cold_mask] += cold_bonus

    if hot_bonus > 0.0 and counts.max() > 0:
        threshold = float(np.percentile(counts, hot_percentile))
        # 임계값과 같거나 더 큰 번호 중 한 번이라도 나온 번호만 핫으로 인정
        hot_mask = (counts >= threshold) & (counts > 0)
        if hot_mask.any():
            base[hot_mask] += hot_bonus

    total = base.sum()
    if total <= 0:
        return np.full(NUMBER_COUNT, 1.0 / NUMBER_COUNT)
    return base / total


def classify_numbers(counts: np.ndarray, hot_percentile: float = 80.0) -> tuple[list[int], list[int]]:
    """최근 출현 counts 벡터에서 hot/cold 번호 분류.

    Returns:
        (hot_numbers, cold_numbers) — 각 1~45 정렬된 정수 리스트.
    """
    cold = [int(i + 1) for i, c in enumerate(counts) if c == 0]
    if counts.max() == 0:
        return [], cold
    threshold = float(np.percentile(counts, hot_percentile))
    hot = [
        int(i + 1)
        for i, c in enumerate(counts)
        if c >= threshold and c > 0
    ]
    return sorted(hot), sorted(cold)
