"""번호 온도 시스템 — Hot/Warm/Neutral/Cold/Frozen 5단계 분류.

본 모듈은 '예측' 을 하지 않는다. 단지 과거 출현 분포의 시각적 메타포로서
각 번호에 5단계 온도 등급을 부여한다.

합성 점수 구성 (각 번호 1~45 별):
  - 최근 출현 편차       (가중 0.5): recent/expected - 1
  - 갭 (마지막 출현 후)  (가중 0.3): -gap/lookback (정규화)
  - 장기 빈도 편차       (가중 0.2): total/expected - 1
  - 최종 점수 = tanh(가중합)  → [-1.0, +1.0]

등급 부여:
  - 점수 백분위로 정확히 9개씩 5단계 (Hot/Warm/Neutral/Cold/Frozen)
  - 절대 임계값이 아닌 상대 순위 — '모든 번호가 동일 확률'이라는 사실과 양립
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

from . import database

Tier = Literal["hot", "warm", "neutral", "cold", "frozen"]

TIER_ORDER: tuple[Tier, ...] = ("hot", "warm", "neutral", "cold", "frozen")
TIER_LABELS_KO: dict[Tier, str] = {
    "hot": "🔥 핫",
    "warm": "🌡 웜",
    "neutral": "➖ 중립",
    "cold": "❄ 콜드",
    "frozen": "🧊 프로즌",
}
TIER_COLORS: dict[Tier, str] = {
    "hot": "#FF4D4D",
    "warm": "#FFA94D",
    "neutral": "#9CA3AF",
    "cold": "#4DA6FF",
    "frozen": "#7B61FF",
}

DEFAULT_LOOKBACK: int = 30
DISCLAIMER: str = (
    "온도 등급은 과거 출현 분포의 시각적 메타포일 뿐, "
    "다음 회차 출현 확률에 영향을 주지 않습니다. "
    "모든 번호의 다음 출현 확률은 동일하게 6/45 입니다."
)


@dataclass
class TemperatureItem:
    number: int
    recent_count: int
    gap: int
    total_count: int
    score: float
    tier: Tier
    rank: int  # 1 = 가장 hot


@dataclass
class TemperatureSummary:
    lookback: int
    latest_round: int
    total_rounds: int
    items: list[TemperatureItem]
    tier_distribution: dict[Tier, int]
    tier_labels: dict[Tier, str]
    tier_colors: dict[Tier, str]
    disclaimer: str


def _recent_counts(df: pd.DataFrame, lookback: int) -> np.ndarray:
    counts = np.zeros(45, dtype=int)
    if df.empty or lookback <= 0:
        return counts
    recent = df.sort_values("round", ascending=False).head(lookback)
    flat = recent[database.NUMBER_COLUMNS].to_numpy(dtype=int).ravel()
    for n in flat:
        if 1 <= n <= 45:
            counts[n - 1] += 1
    return counts


def _total_counts(df: pd.DataFrame) -> np.ndarray:
    counts = np.zeros(45, dtype=int)
    if df.empty:
        return counts
    flat = df[database.NUMBER_COLUMNS].to_numpy(dtype=int).ravel()
    for n in flat:
        if 1 <= n <= 45:
            counts[n - 1] += 1
    return counts


def _compute_gaps(df: pd.DataFrame, latest_round: int) -> np.ndarray:
    """각 번호 1~45 의 마지막 출현 이후 경과 회차. 미출현은 latest_round."""
    gaps = np.full(45, latest_round, dtype=int)
    sentinel = latest_round  # 아직 발견 안 된 표시
    sorted_df = df.sort_values("round", ascending=False)
    for _, row in sorted_df.iterrows():
        rnd = int(row["round"])
        elapsed = latest_round - rnd
        for col in database.NUMBER_COLUMNS:
            n = int(row[col])
            if 1 <= n <= 45 and gaps[n - 1] == sentinel:
                gaps[n - 1] = elapsed
        # 모든 번호가 갱신되었으면 조기 종료 (성능)
        if not (gaps == sentinel).any():
            break
    return gaps


def _composite_score(
    recent: np.ndarray,
    gaps: np.ndarray,
    total: np.ndarray,
    lookback: int,
    total_rounds: int,
) -> np.ndarray:
    """합성 온도 점수 — tanh 압축으로 [-1, +1] 보장."""
    expected_recent = max(1, lookback) * 6.0 / 45.0
    expected_total = max(1, total_rounds) * 6.0 / 45.0

    recency = (recent.astype(float) / expected_recent) - 1.0
    gap_bias = -np.clip(gaps.astype(float) / max(1, lookback), 0.0, 3.0)
    long_term = (total.astype(float) / expected_total) - 1.0

    raw = 0.5 * recency + 0.3 * gap_bias + 0.2 * long_term
    return np.tanh(raw)


def _classify_by_rank(scores: np.ndarray) -> tuple[list[Tier], list[int]]:
    """점수 내림차순 랭크 → 9개씩 5단계 분배. (tiers, ranks_1based) 반환."""
    order = np.argsort(-scores)  # descending: 가장 hot 인 인덱스가 0번째
    tiers: list[Tier] = [TIER_ORDER[2]] * 45  # 기본 neutral
    ranks: list[int] = [0] * 45
    for rank, idx in enumerate(order):
        i = int(idx)
        ranks[i] = rank + 1
        if rank < 9:
            tiers[i] = "hot"
        elif rank < 18:
            tiers[i] = "warm"
        elif rank < 27:
            tiers[i] = "neutral"
        elif rank < 36:
            tiers[i] = "cold"
        else:
            tiers[i] = "frozen"
    return tiers, ranks


def compute_temperature(
    df: pd.DataFrame,
    lookback: int = DEFAULT_LOOKBACK,
) -> TemperatureSummary:
    """전체 회차 DataFrame 으로부터 1~45 번호 각각의 온도 등급 산출."""
    if df is None or df.empty:
        return TemperatureSummary(
            lookback=lookback,
            latest_round=0,
            total_rounds=0,
            items=[],
            tier_distribution={t: 0 for t in TIER_ORDER},
            tier_labels=TIER_LABELS_KO,
            tier_colors=TIER_COLORS,
            disclaimer=DISCLAIMER,
        )

    latest_round = int(df["round"].max())
    total_rounds = int(len(df))

    recent = _recent_counts(df, lookback)
    gaps = _compute_gaps(df, latest_round)
    total = _total_counts(df)

    scores = _composite_score(recent, gaps, total, lookback, total_rounds)
    tiers, ranks = _classify_by_rank(scores)

    items: list[TemperatureItem] = []
    for i in range(45):
        items.append(
            TemperatureItem(
                number=i + 1,
                recent_count=int(recent[i]),
                gap=int(gaps[i]),
                total_count=int(total[i]),
                score=float(scores[i]),
                tier=tiers[i],
                rank=ranks[i],
            )
        )

    distribution = {t: sum(1 for it in items if it.tier == t) for t in TIER_ORDER}

    return TemperatureSummary(
        lookback=lookback,
        latest_round=latest_round,
        total_rounds=total_rounds,
        items=items,
        tier_distribution=distribution,
        tier_labels=TIER_LABELS_KO,
        tier_colors=TIER_COLORS,
        disclaimer=DISCLAIMER,
    )
