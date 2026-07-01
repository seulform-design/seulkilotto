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

def machine_from_date(d: date) -> int:
    """날짜만으로 호기 추정(월별 순환). 회차를 아는 경우 machine_registry.resolve
    를 직접 쓰는 편이 정확하다(확정 기록 우선)."""
    from .machine_registry import monthly_rotation

    return monthly_rotation(d)


def attach_machine_column(df: pd.DataFrame) -> pd.DataFrame:
    """각 회차에 실제 호기를 부여. 확정 기록(카페) 우선, 없으면 월별 순환 추정."""
    from .machine_registry import resolve

    out = df.copy()
    dates = pd.to_datetime(out["draw_date"], errors="coerce").dt.date
    rounds = out["round"].astype(int).tolist()
    out["machine_id"] = [resolve(r, d)[0] for r, d in zip(rounds, dates)]
    out["machine_source"] = [resolve(r, d)[1] for r, d in zip(rounds, dates)]
    return out


def predict_next_round(df: pd.DataFrame) -> Tuple[int, str, int]:
    from .machine_registry import resolve

    latest = df.sort_values("round").iloc[-1]
    latest_round = int(latest["round"])
    latest_date = pd.to_datetime(latest["draw_date"]).date()

    next_round = effective_current_round(latest_round)
    weeks_ahead = max(1, next_round - latest_round)
    next_date = latest_date + timedelta(days=7 * weeks_ahead)
    next_machine = resolve(next_round, next_date)[0]
    return next_round, next_date.isoformat(), next_machine


def machine_overview(df: pd.DataFrame, recent: int = 16) -> Dict:
    """추첨기(호기) 현황 — 실제 기록 커버리지, 최근 순환 이력, 다음 회차 예측,
    호기별 사용 통계. '완벽 재연' UI 의 데이터 소스."""
    from .machine_registry import CONFIRMED, ROTATION_ORDER, coverage, resolve

    dfm = attach_machine_column(df).sort_values("round")
    latest_round = int(dfm["round"].max())
    next_round, next_date, _ = predict_next_round(df)
    next_machine, next_source = resolve(next_round, pd.to_datetime(next_date).date())

    # 최근 이력 (회차 내림차순)
    tail = dfm.tail(recent).iloc[::-1]
    recent_hist = [
        {
            "round": int(r["round"]),
            "machine": int(r["machine_id"]),
            "source": str(r.get("machine_source", "estimated")),
            "confirmed": int(r["round"]) in CONFIRMED,
        }
        for _, r in tail.iterrows()
    ]

    # 현재(최신) 블록 길이 — 최신 회차부터 같은 호기 연속 개수
    latest_machine = int(dfm.iloc[-1]["machine_id"])
    block_len = 0
    for _, r in dfm.iloc[::-1].iterrows():
        if int(r["machine_id"]) == latest_machine:
            block_len += 1
        else:
            break
    nxt_in_rotation = ROTATION_ORDER[(ROTATION_ORDER.index(latest_machine) + 1) % 3]

    # 호기별 사용 통계 (확정 기록 기준)
    per_machine: Dict[int, Dict[str, int]] = {}
    for m in (1, 2, 3):
        rounds_m = [rd for rd, mm in CONFIRMED.items() if mm == m]
        per_machine[m] = {
            "count": len(rounds_m),
            "last_round": max(rounds_m) if rounds_m else 0,
        }

    return {
        "coverage": coverage(),
        "latest_round": latest_round,
        "latest_machine": latest_machine,
        "current_block_len": block_len,
        "next_round": next_round,
        "next_draw_date": next_date,
        "next_machine": next_machine,
        "next_source": next_source,
        "next_in_rotation": nxt_in_rotation,
        "rotation_order": list(ROTATION_ORDER),
        "recent_history": recent_hist,
        "per_machine": {str(k): v for k, v in per_machine.items()},
        "note": (
            "호기는 lottotapa 969회(262~1230) 실측 + 당첨번호 100% 대조 검증. "
            "1~261회는 기록 미확보로 월별순환 추정. 다음 회차는 1→2→3 순환 예측(추첨 후 확정)."
        ),
    }


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

    # 평균회귀 풀 — 미출현(보너스포함 gap) + 저빈도 결합 상위.
    # 핫추종(hot)이 100회차 백테스트에서 유의한 역신호(z≈-2.7)이고, 궁합쌍
    # (synergy)은 더 나쁨(z≈-3.6)이라, 신호 합산에는 그 반대 풀을 쓴다.
    # (미출현/저빈도 결합은 lift +0.08, z+0.8 로 양전환 검증됨.)
    from .gap_utils import last_seen_gaps

    rev_gaps = last_seen_gaps(sub, include_bonus=True)
    gap_rank = {n: r for r, n in enumerate(sorted(ALL_NUMBERS, key=lambda x: -rev_gaps[x]))}
    freq_rank = {n: r for r, n in enumerate(sorted(ALL_NUMBERS, key=lambda x: freq.get(x, 0)))}
    reversion = sorted(ALL_NUMBERS, key=lambda n: gap_rank[n] * 0.6 + freq_rank[n] * 0.4)

    return {
        "draw_count": len(sub),
        "hot_top5": [{"number": n, "count": c} for n, c in hot[:5]],
        "cold_top5": [{"number": n, "gap_rounds": g} for n, g in absence[:5]],
        "reversion_top10": reversion[:10],
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
    from .machine_registry import coverage, resolve

    df = attach_machine_column(df)
    next_round, next_date, auto_machine = predict_next_round(df)
    target = machine_id if machine_id in (1, 2, 3) else auto_machine

    stats = analyze_machine(df, target)
    combos = generate_round_recommendations(stats, seed=seed)

    public_stats = {k: v for k, v in stats.items() if not k.startswith("_")}
    warning = None
    if stats.get("draw_count", 0) > 0 and not combos:
        warning = "조건을 만족하는 조합 생성에 실패했습니다. 필터를 완화해 재시도하세요."

    # 다음 회차 호기의 출처(확정/추정) — 실제 기록 기반 여부를 프론트에 노출.
    next_source = resolve(next_round, None)[1]
    machine_cov = coverage()

    return {
        "next_round": next_round,
        "next_draw_date": next_date,
        "machine_id": target,
        "auto_machine_id": auto_machine,
        "machine_source": next_source,
        "machine_data_coverage": machine_cov,
        "latest_round": int(df["round"].max()),
        "stats": public_stats,
        "combinations": combos,
        "warning": warning,
        "filter_rule": "총합 100~175, 홀짝 2:4|3:3|4:2",
        "compose_rule": "고빈도 3 + 미출현 1 + 궁합/연번 2",
    }
