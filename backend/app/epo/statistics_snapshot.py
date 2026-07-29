"""StatisticsSnapshot serializer — EPO HistoricalProfile → 버전드 JSON.

추천 점수에 연결하지 않는다. Explain·EPO 필터 기준선·재현용 export 전용.
스키마: artifacts/05_statistics/SCHEMA.md (0.1.0)
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pandas as pd

from .. import database
from .historical_stats import HistoricalProfile, _FALLBACK, compute_profile

SNAPSHOT_VERSION = "0.1.0"
ARTIFACT_ID = "05_statistics"
UNIFORM_HIT_PROB = 6.0 / 45.0
UNIFORM_TOP6_HITS = 6.0 * UNIFORM_HIT_PROB
JACKPOT_ODDS = "1/8145060"
HONESTY = "경험적 분포일 뿐이며 i.i.d.·당첨 확률을 바꾸지 않는다."

DECADE_LABELS = ["1-10", "11-20", "21-30", "31-40", "41-45"]
# 균등 추첨 시 밴드별 기대 비율 (밴드 크기 / 45)
DECADE_EXPECTED = [10 / 45, 10 / 45, 10 / 45, 10 / 45, 5 / 45]


def decade_of(n: int) -> int:
    """번호 → 5밴드 인덱스 (용지 L3 decade UI와 동일)."""
    return min(4, max(0, (int(n) - 1) // 10))


def _decade_hit_rates(df: pd.DataFrame) -> tuple[list[float | None], list[float]]:
    """당첨 번호 슬롯 중 각 decade 밴드 비율 + 기대 대비 lift.

    hit_rate = (해당 밴드 당첨 번호 개수) / (전체 당첨 슬롯).
    점수 주입용이 아니라 관측·Explain 기준선용.
    """
    if df is None or df.empty:
        return [None, None, None, None, None], list(DECADE_EXPECTED)
    flat = df[database.NUMBER_COLUMNS].to_numpy().ravel()
    counts = [0, 0, 0, 0, 0]
    total = 0
    for v in flat:
        iv = int(v)
        if 1 <= iv <= 45:
            counts[decade_of(iv)] += 1
            total += 1
    if total <= 0:
        return [None, None, None, None, None], list(DECADE_EXPECTED)
    rates = [round(c / total, 6) for c in counts]
    return rates, list(DECADE_EXPECTED)


def profile_to_snapshot(
    profile: HistoricalProfile,
    *,
    dataset: str = "historical",
    round_scope: str = "archived",
    round_from: int | None = None,
    round_to: int | None = None,
    exclude_intents: list[str] | None = None,
    include_carry: bool = False,
    number_counts: dict[int, int] | None = None,
    frequency_window: str = "all",
    frequency_window_n: int | None = None,
    decade_hit_rates: list[float | None] | None = None,
    decade_expected: list[float] | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """HistoricalProfile → StatisticsSnapshot dict (SCHEMA 0.1.0)."""
    count = int(profile.rounds_analyzed)
    rates = decade_hit_rates if decade_hit_rates is not None else [None, None, None, None, None]
    expected = decade_expected if decade_expected is not None else list(DECADE_EXPECTED)
    snap: dict[str, Any] = {
        "version": SNAPSHOT_VERSION,
        "artifact_id": ARTIFACT_ID,
        "created_at": created_at or datetime.now(timezone.utc).isoformat(),
        "round_scope": round_scope,
        "source": {
            "dataset": dataset,
            "rounds": {
                "from": round_from,
                "to": round_to,
                "count": count,
            },
            "exclude_intents": list(exclude_intents if exclude_intents is not None else ["review"]),
        },
        "empirical": {
            "sum": {
                "p01": int(profile.sum_p01),
                "p10": int(profile.sum_p10),
                "p50": int(profile.sum_p50),
                "p90": int(profile.sum_p90),
                "p99": int(profile.sum_p99),
                "mean": float(profile.sum_mean),
            },
            "odd_count_freq": {str(k): float(v) for k, v in sorted(profile.odd_count_freq.items())},
            "high_count_freq": {str(k): float(v) for k, v in sorted(profile.high_count_freq.items())},
            "odd_count_modes": list(profile.odd_count_modes),
            "high_count_modes": list(profile.high_count_modes),
            "ac": {"mean": float(profile.avg_ac), "p10": int(profile.p10_ac)},
            "max_run_p95": int(profile.max_run_p95),
        },
        "decade_bands": {
            "labels": list(DECADE_LABELS),
            "hit_rate_per_band": rates,
            "expected_per_band": expected,
            "note": "용지 L3/decade UI와 동일 5밴드; 관측 비율(점수 미연결)",
        },
        "frequency": {
            "number_counts": {str(k): int(v) for k, v in sorted((number_counts or {}).items())},
            "window": frequency_window,
            "window_n": frequency_window_n,
        },
        "baselines": {
            "uniform_hit_prob": UNIFORM_HIT_PROB,
            "uniform_top6_hits": UNIFORM_TOP6_HITS,
            "jackpot_odds": JACKPOT_ODDS,
        },
        "honesty": HONESTY,
        "mapped_impl": {
            "epo_profile": "backend/app/epo/historical_stats.py#HistoricalProfile",
            "significance": "backend/app/video_analysis/stats.py",
        },
    }
    if include_carry and profile.last_round_no is not None:
        snap["carry"] = {
            "last_round_no": int(profile.last_round_no),
            "last_round_combo": list(profile.last_round_combo),
        }
    return snap


def _number_counts_from_df(df: pd.DataFrame) -> dict[int, int]:
    if df is None or df.empty:
        return {}
    flat = df[database.NUMBER_COLUMNS].to_numpy().ravel()
    counts: dict[int, int] = {n: 0 for n in range(1, 46)}
    for v in flat:
        iv = int(v)
        if 1 <= iv <= 45:
            counts[iv] = counts.get(iv, 0) + 1
    return counts


def build_snapshot_from_history(
    df: pd.DataFrame | None,
    *,
    include_carry: bool = False,
    recent_n: int | None = None,
) -> dict[str, Any]:
    """당첨 이력 DataFrame → StatisticsSnapshot.

    recent_n 이 있으면 최근 N회만 사용(frequency window=last_N).
    빈 DF → _FALLBACK 프로필(보수값).
    """
    work = df
    window = "all"
    window_n = None
    if df is not None and not df.empty and recent_n is not None and recent_n > 0:
        work = df.sort_values("round").tail(int(recent_n))
        window = "last_N"
        window_n = int(recent_n)

    if work is None or work.empty:
        profile = _FALLBACK
        round_from = round_to = None
        counts: dict[int, int] = {}
        decade_rates: list[float | None] = [None, None, None, None, None]
        decade_exp = list(DECADE_EXPECTED)
    else:
        profile = compute_profile(work)
        rounds = work["round"].astype(int)
        round_from = int(rounds.min())
        round_to = int(rounds.max())
        counts = _number_counts_from_df(work)
        decade_rates, decade_exp = _decade_hit_rates(work)

    return profile_to_snapshot(
        profile,
        dataset="historical",
        round_scope="archived",
        round_from=round_from,
        round_to=round_to,
        include_carry=include_carry,
        number_counts=counts,
        frequency_window=window,
        frequency_window_n=window_n,
        decade_hit_rates=decade_rates,
        decade_expected=decade_exp,
    )
