"""호기(추첨기)별 패턴 분석 및 다음 회차 추천 (Pandas 기반)."""
from __future__ import annotations

import random
from datetime import date, timedelta
from itertools import combinations
from typing import Dict, List, Optional, Sequence, Set, Tuple

import pandas as pd

from .data_meta import effective_current_round
from .database import NUMBER_COLUMNS

ALL_NUMBERS = list(range(1, 46))
SUM_MIN, SUM_MAX = 100, 175
VALID_ODD = {2, 3, 4}
NUM_GAMES = 5
MAX_GENERATION_ATTEMPTS = 5000

QUARTER_TO_MACHINE: Dict[Tuple[int, int], int] = {
    (2023, 1): 2, (2023, 2): 3, (2023, 3): 1, (2023, 4): 2,
    (2024, 1): 3, (2024, 2): 1, (2024, 3): 2, (2024, 4): 3,
    (2025, 1): 1, (2025, 2): 2, (2025, 3): 3, (2025, 4): 1,
    (2026, 1): 2, (2026, 2): 3, (2026, 3): 1, (2026, 4): 2,
}
MONTH_TO_MACHINE: Dict[Tuple[int, int], int] = {
    **{(2024, m): {1: 3, 2: 3, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 3, 9: 3, 10: 3, 11: 2, 12: 2}[m] for m in range(1, 13)},
    **{(2025, m): {1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 1, 10: 1, 11: 2, 12: 2}[m] for m in range(1, 13)},
    **{(2026, m): {1: 2, 2: 2, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 2, 10: 2, 11: 3, 12: 3}[m] for m in range(1, 13)},
}
CYCLE_ANCHOR = (2002, 1, 1)


def _quarter(d: date) -> int:
    return (d.month - 1) // 3 + 1


def machine_from_date(d: date) -> int:
    qk = (d.year, _quarter(d))
    if qk in QUARTER_TO_MACHINE:
        return QUARTER_TO_MACHINE[qk]
    mk = (d.year, d.month)
    if mk in MONTH_TO_MACHINE:
        return MONTH_TO_MACHINE[mk]
    ay, aq, am = CYCLE_ANCHOR
    offset = (d.year - ay) * 4 + (_quarter(d) - aq)
    return ((am - 1 + offset) % 3) + 1


def attach_machine_column(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    dates = pd.to_datetime(out["draw_date"], errors="coerce").dt.date
    out["machine_id"] = [machine_from_date(d) if d else 1 for d in dates]
    return out


def predict_next_round(df: pd.DataFrame) -> Tuple[int, str, int]:
    latest = df.sort_values("round").iloc[-1]
    latest_round = int(latest["round"])
    latest_date = pd.to_datetime(latest["draw_date"]).date()

    next_round = effective_current_round(latest_round)
    weeks_ahead = max(1, next_round - latest_round)
    next_date = latest_date + timedelta(days=7 * weeks_ahead)
    next_machine = machine_from_date(next_date)
    return next_round, next_date.isoformat(), next_machine


def _absence_gaps(sub: pd.DataFrame) -> List[Tuple[int, int]]:
    """호기(부분집합) 내 각 번호의 '몇 회차 동안 미출현'. gap_utils 단일 소스.
    미출현 많은 순 → 번호 순으로 정렬해 반환."""
    from .gap_utils import last_seen_gaps

    gaps = last_seen_gaps(sub)
    absence = [(n, gaps[n]) for n in ALL_NUMBERS]
    absence.sort(key=lambda x: (-x[1], x[0]))
    return absence


def analyze_machine(df: pd.DataFrame, machine_id: int) -> Dict:
    sub = df[df["machine_id"] == machine_id]
    if sub.empty:
        return {"draw_count": 0}

    freq: Dict[int, int] = {}
    consec: Dict[Tuple[int, int], int] = {}
    synergy: Dict[Tuple[int, int], int] = {}
    sums: List[int] = []
    odds: List[int] = []

    for _, row in sub.iterrows():
        nums = sorted(int(row[c]) for c in NUMBER_COLUMNS)
        for n in nums:
            freq[n] = freq.get(n, 0) + 1
        for i in range(5):
            if nums[i + 1] - nums[i] == 1:
                consec[(nums[i], nums[i + 1])] = consec.get((nums[i], nums[i + 1]), 0) + 1
        for pair in combinations(nums, 2):
            synergy[pair] = synergy.get(pair, 0) + 1
        sums.append(sum(nums))
        odds.append(sum(1 for n in nums if n % 2 == 1))

    absence = _absence_gaps(sub)
    hot = sorted(freq.items(), key=lambda x: (-x[1], x[0]))

    return {
        "draw_count": len(sub),
        "hot_top5": [{"number": n, "count": c} for n, c in hot[:5]],
        "cold_top5": [{"number": n, "gap_rounds": g} for n, g in absence[:5]],
        "consecutive_top3": [
            {"pair": [a, b], "count": c}
            for (a, b), c in sorted(consec.items(), key=lambda x: -x[1])[:3]
        ],
        "synergy_top3": [
            {"pair": [a, b], "count": c}
            for (a, b), c in sorted(synergy.items(), key=lambda x: -x[1])[:3]
        ],
        "avg_sum": round(sum(sums) / len(sums), 1),
        "avg_odd": round(sum(odds) / len(odds), 2),
        "_hot_pool": [n for n, _ in hot[:15]],
        "_cold_pool": [n for n, _ in absence[:15]],
        "_pairs": _merge_pairs(consec, synergy),
    }


def _merge_pairs(
    consec: Dict[Tuple[int, int], int],
    synergy: Dict[Tuple[int, int], int],
) -> List[Tuple[int, int]]:
    scored: Dict[Tuple[int, int], int] = {}
    for p, c in consec.items():
        scored[p] = scored.get(p, 0) + c * 2
    for p, c in synergy.items():
        scored[p] = scored.get(p, 0) + c
    return [p for p, _ in sorted(scored.items(), key=lambda x: (-x[1], x[0]))[:12]]


def _is_valid(nums: Sequence[int], strict_sum: bool = True) -> bool:
    if len(nums) != 6 or len(set(nums)) != 6:
        return False
    if not all(1 <= n <= 45 for n in nums):
        return False
    s = sum(nums)
    if strict_sum and (s < SUM_MIN or s > SUM_MAX):
        return False
    odd = sum(1 for n in nums if n % 2 == 1)
    return odd in VALID_ODD


def _build_one_combo(
    rng: random.Random,
    hot: List[int],
    cold: List[int],
    pairs: List[Tuple[int, int]],
    strict_sum: bool,
) -> Optional[List[int]]:
    chosen: Set[int] = set()

    hot_cands = [n for n in hot if n not in chosen]
    if len(hot_cands) < 3:
        hot_cands = [n for n in ALL_NUMBERS if n not in chosen]
    if len(hot_cands) < 3:
        return None
    chosen.update(rng.sample(hot_cands, 3))

    cold_cands = [n for n in cold if n not in chosen] or [n for n in ALL_NUMBERS if n not in chosen]
    chosen.add(rng.choice(cold_cands))

    if pairs:
        a, b = rng.choice(pairs)
        for n in (a, b):
            if n not in chosen:
                chosen.add(n)

    while len(chosen) < 6:
        pool = [n for n in hot if n not in chosen] or [n for n in ALL_NUMBERS if n not in chosen]
        chosen.add(rng.choice(pool))

    nums = sorted(chosen)
    return nums if _is_valid(nums, strict_sum=strict_sum) else None


def generate_round_recommendations(
    analysis: Dict,
    seed: Optional[int] = None,
    n_games: int = NUM_GAMES,
) -> List[Dict]:
    if analysis.get("draw_count", 0) == 0:
        return []

    rng = random.Random(seed)
    hot = analysis.get("_hot_pool") or ALL_NUMBERS
    cold = analysis.get("_cold_pool") or ALL_NUMBERS
    pairs = analysis.get("_pairs") or []

    games: List[List[int]] = []
    attempts = 0
    while len(games) < n_games and attempts < MAX_GENERATION_ATTEMPTS:
        attempts += 1
        combo = _build_one_combo(rng, hot, cold, pairs, strict_sum=True)
        if combo is None or combo in games:
            continue
        games.append(combo)

    # 필터가 너무 빡빡할 때: 총합만 완화
    if len(games) < n_games:
        attempts2 = 0
        while len(games) < n_games and attempts2 < 2000:
            attempts2 += 1
            combo = _build_one_combo(rng, hot, cold, pairs, strict_sum=False)
            if combo is None or combo in games:
                continue
            games.append(combo)

    return [
        {
            "numbers": g,
            "sum_total": sum(g),
            "odd_count": sum(1 for n in g if n % 2 == 1),
            "even_count": sum(1 for n in g if n % 2 == 0),
        }
        for g in games
    ]


def build_round_recommendation(
    df: pd.DataFrame,
    machine_id: Optional[int] = None,
    seed: Optional[int] = None,
) -> Dict:
    df = attach_machine_column(df)
    next_round, next_date, auto_machine = predict_next_round(df)
    target = machine_id if machine_id in (1, 2, 3) else auto_machine

    stats = analyze_machine(df, target)
    combos = generate_round_recommendations(stats, seed=seed)

    public_stats = {k: v for k, v in stats.items() if not k.startswith("_")}
    warning = None
    if stats.get("draw_count", 0) > 0 and not combos:
        warning = "조건을 만족하는 조합 생성에 실패했습니다. 필터를 완화해 재시도하세요."

    return {
        "next_round": next_round,
        "next_draw_date": next_date,
        "machine_id": target,
        "auto_machine_id": auto_machine,
        "latest_round": int(df["round"].max()),
        "stats": public_stats,
        "combinations": combos,
        "warning": warning,
        "filter_rule": "총합 100~175, 홀짝 2:4|3:3|4:2",
        "compose_rule": "고빈도 3 + 미출현 1 + 궁합/연번 2",
    }
