"""후속출현 패턴 분석 엔진 — 실제 당첨 데이터 기반 통계만 사용."""
from __future__ import annotations

import math
from collections import Counter
from itertools import combinations
from typing import Dict, List, Sequence, Set, Tuple

import numpy as np
import pandas as pd

from .database import NUMBER_COLUMNS

ALL_NUMBERS = list(range(1, 46))
MIN_COMBO_SIZE = 2  # 2개 이상 조합만 후속출현 분석에 반영 (1개는 과다 매칭)
MIN_DISCOVERY = 2  # 발견 2회 미만 조합 제외
HIGH_CONFIDENCE_DISCOVERY = 10  # 신뢰(과최적화 방지) 기준
RECENT_WINDOWS = (100, 200, 300, 500)
LAMBDA_CANDIDATES = (0.001, 0.003, 0.005, 0.01, 0.02, 0.05)
ZONES = [(1, 10), (11, 20), (21, 30), (31, 40), (41, 45)]
DISCLAIMER = (
    "로또는 무작위 추첨입니다. 분석 결과는 통계 모델이며 당첨을 보장하지 않습니다. "
    "모든 수치는 실제 당첨 데이터에서 계산되었습니다."
)


def _wilson_ci(successes: int, trials: int, z: float = 1.96) -> Tuple[float, float]:
    if trials <= 0:
        return 0.0, 0.0
    p = successes / trials
    z2 = z * z
    denom = 1 + z2 / trials
    centre = p + z2 / (2 * trials)
    margin = z * math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
    return max(0.0, (centre - margin) / denom), min(1.0, (centre + margin) / denom)


def _minmax_scale(values: Dict[int, float]) -> Dict[int, float]:
    if not values:
        return values
    lo, hi = min(values.values()), max(values.values())
    if hi == lo:
        return {k: 50.0 for k in values}
    return {k: round(100 * (v - lo) / (hi - lo), 4) for k, v in values.items()}


def _grade(rank_pct: float) -> str:
    if rank_pct <= 0.10:
        return "S"
    if rank_pct <= 0.30:
        return "A"
    if rank_pct <= 0.60:
        return "B"
    return "C"


def _mirror(n: int) -> int:
    return 46 - n if 1 <= n <= 45 else n


def _row_numbers(row) -> List[int]:
    return sorted(int(row[c]) for c in NUMBER_COLUMNS)


def _build_draws(df: pd.DataFrame) -> List[Dict]:
    ordered = df.sort_values("round")
    draws = []
    for _, row in ordered.iterrows():
        nums = _row_numbers(row)
        draws.append(
            {
                "round": int(row["round"]),
                "numbers": nums,
                "bonus": int(row["bonus"]),
                "ns": set(nums),
                "all7": set(nums) | {int(row["bonus"])},
            }
        )
    return draws


def _all_trigger_combos(nums: Sequence[int]) -> List[Tuple[int, ...]]:
    out: List[Tuple[int, ...]] = []
    for k in range(1, 7):
        out.extend(combinations(sorted(nums), k))
    return out


def _find_match_indices(
    combo: Sequence[int],
    draws: List[Dict],
    before_round: int,
) -> List[int]:
    cset = set(combo)
    return [
        i
        for i, d in enumerate(draws)
        if d["round"] < before_round and cset <= d["ns"]
    ]


def _counter_items(counter: Counter, limit: int = 10) -> List[Dict]:
    return [{"number": int(n), "count": int(c)} for n, c in counter.most_common(limit)]


def _combo_exclusion_reason(size: int, discovery_count: int) -> str | None:
    if size < MIN_COMBO_SIZE:
        return "단일번호조합(분석제외)"
    if discovery_count < MIN_DISCOVERY:
        return f"발견{MIN_DISCOVERY}회미만"
    return None


def _jaccard(a: Set[int], b: Set[int]) -> float:
    u = len(a | b)
    return len(a & b) / u if u else 0.0


def _cosine(a: Set[int], b: Set[int]) -> float:
    dot = len(a & b)
    na, nb = math.sqrt(len(a)), math.sqrt(len(b))
    return dot / (na * nb) if na and nb else 0.0


def _overlap_coef(a: Set[int], b: Set[int]) -> float:
    m = min(len(a), len(b))
    return len(a & b) / m if m else 0.0


def _pagerank(adj: np.ndarray, damping: float = 0.85, iters: int = 80) -> np.ndarray:
    n = adj.shape[0]
    if n == 0:
        return np.array([])
    row_sum = adj.sum(axis=1)
    M = np.zeros_like(adj)
    for i in range(n):
        if row_sum[i] > 0:
            M[i] = adj[i] / row_sum[i]
    rank = np.ones(n) / n
    for _ in range(iters):
        rank = (1 - damping) / n + damping * M.T @ rank
    return rank


def _degree_centrality(adj: np.ndarray) -> np.ndarray:
    n = adj.shape[0]
    if n <= 1:
        return np.zeros(n)
    return adj.sum(axis=1) / (n - 1)


def _betweenness_approx(adj: np.ndarray) -> np.ndarray:
    """Brandes — 45노드 규모."""
    n = adj.shape[0]
    bc = np.zeros(n)
    for s in range(n):
        stack: List[int] = []
        pred: List[List[int]] = [[] for _ in range(n)]
        sigma = np.zeros(n)
        sigma[s] = 1.0
        dist = np.full(n, -1)
        dist[s] = 0
        queue = [s]
        while queue:
            v = queue.pop(0)
            stack.append(v)
            for w in range(n):
                if adj[v, w] <= 0:
                    continue
                if dist[w] < 0:
                    dist[w] = dist[v] + 1
                    queue.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)
        delta = np.zeros(n)
        while stack:
            w = stack.pop()
            for v in pred[w]:
                if sigma[w] > 0:
                    delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
            if w != s:
                bc[w] += delta[w]
    if n > 2:
        bc /= (n - 1) * (n - 2)
    return bc


def _eigenvector_centrality(adj: np.ndarray, iters: int = 60) -> np.ndarray:
    n = adj.shape[0]
    if n == 0:
        return np.array([])
    x = np.ones(n)
    for _ in range(iters):
        x = adj @ x
        norm = np.linalg.norm(x)
        if norm > 0:
            x = x / norm
    return x


def _combo_passes_filters(nums: List[int]) -> bool:
    odd = sum(1 for n in nums if n % 2 == 1)
    if odd not in (2, 3, 4):
        return False
    low = sum(1 for n in nums if n <= 22)
    high = 6 - low
    if low < 2 or high < 2:
        return False
    consec = sum(1 for i in range(5) if nums[i + 1] - nums[i] == 1)
    if consec > 2:
        return False
    ends = Counter(n % 10 for n in nums)
    if max(ends.values()) > 2:
        return False
    s = sum(nums)
    if not (90 <= s <= 180):
        return False
    for lo, hi in ZONES:
        if not any(lo <= n <= hi for n in nums):
            return False
    return True


def _pick_combo(
    ranked: List[Dict],
    used_sets: Set[Tuple[int, ...]],
    bias: str,
) -> List[int] | None:
    """결정론적 조합 선택 — 임의 난수 없음."""
    nums_by_score = [r["number"] for r in ranked]
    score_map = {r["number"]: r["score"] for r in ranked}

    if bias == "aggressive":
        pool = nums_by_score[:25]
    elif bias == "high_payout":
        pool = [n for n in nums_by_score if n > 31] + nums_by_score
        pool = list(dict.fromkeys(pool))[:30]
    else:
        pool = nums_by_score[:15]

    best: List[int] | None = None
    best_score = -1.0
    for combo in combinations(pool, 6):
        picked = sorted(combo)
        key = tuple(picked)
        if key in used_sets:
            continue
        if not _combo_passes_filters(picked):
            continue
        sc = sum(score_map.get(n, 0) for n in picked)
        if bias == "stable":
            zones = sum(1 for lo, hi in ZONES if any(lo <= n <= hi for n in picked))
            sc += zones * 2
        elif bias == "high_payout":
            sc += sum(3 for n in picked if n > 31)
        if sc > best_score:
            best_score = sc
            best = picked
    return best


def run_post_occurrence_analysis(
    df: pd.DataFrame,
    trigger_round: int | None = None,
    trigger_numbers: List[int] | None = None,
    trigger_bonus: int | None = None,
) -> Dict:
    """19단계 후속출현 분석 파이프라인."""
    draws = _build_draws(df)
    if len(draws) < 20:
        return {"error": "데이터 부족", "min_required": 20, "disclaimer": DISCLAIMER}

    latest = draws[-1]
    if trigger_round is not None:
        match = next((d for d in draws if d["round"] == trigger_round), None)
        if match:
            trigger = match
        elif trigger_numbers and len(trigger_numbers) == 6:
            trigger = {
                "round": trigger_round,
                "numbers": sorted(trigger_numbers),
                "bonus": trigger_bonus or 0,
                "ns": set(trigger_numbers),
            }
        else:
            return {"error": f"회차 {trigger_round} 없음", "disclaimer": DISCLAIMER}
    else:
        trigger = latest

    nums = trigger_numbers or trigger["numbers"]
    bonus = trigger_bonus if trigger_bonus is not None else trigger.get("bonus", 0)
    nums = sorted(set(nums))
    if len(nums) != 6 or any(n < 1 or n > 45 for n in nums):
        return {"error": "트리거 번호 6개 필요 (1~45)", "disclaimer": DISCLAIMER}

    if trigger_numbers and set(nums) != set(latest["numbers"]):
        trigger = {
            "round": latest["round"] + 1,
            "numbers": nums,
            "bonus": bonus,
            "ns": set(nums),
        }

    trigger_set = set(nums)
    latest_round = latest["round"]
    total_rounds = len(draws)
    round_to_idx = {d["round"]: i for i, d in enumerate(draws)}

    # ── 1~2단계: 조합 생성 + 과거 매칭 ─────────────────────────────
    combos = _all_trigger_combos(nums)
    combo_results: List[Dict] = []
    all_match_indices: List[int] = []
    match_rounds: List[int] = []

    for combo in combos:
        found = _find_match_indices(combo, draws, trigger["round"])
        size = len(combo)
        disc = len(found)
        included = size >= MIN_COMBO_SIZE and disc >= MIN_DISCOVERY
        combo_results.append(
            {
                "combo": list(combo),
                "size": size,
                "discovery_count": disc,
                "discovery_rounds": [draws[i]["round"] for i in found],
                "match_indices": found,
                "included_in_analysis": included,
                "trusted": size >= MIN_COMBO_SIZE and disc >= HIGH_CONFIDENCE_DISCOVERY,
                "excluded_reason": _combo_exclusion_reason(size, disc),
            }
        )
        if included:
            all_match_indices.extend(found)
            match_rounds.extend(draws[i]["round"] for i in found)

    unique_match_indices = sorted(set(all_match_indices))
    trusted_indices: List[int] = []
    for cr in combo_results:
        if cr["trusted"]:
            trusted_indices.extend(cr["match_indices"])
    trusted_indices = sorted(set(trusted_indices))

    excluded_single = sum(1 for cr in combo_results if cr["size"] < MIN_COMBO_SIZE)
    excluded_low_discovery = sum(
        1
        for cr in combo_results
        if cr["size"] >= MIN_COMBO_SIZE and cr["discovery_count"] < MIN_DISCOVERY
    )
    included_combo_count = sum(1 for cr in combo_results if cr["included_in_analysis"])

    # ── 3단계: 다음 회차 수집 ───────────────────────────────────────
    next_main: List[int] = []
    next_with_bonus: List[int] = []
    next_events = 0
    event_meta: List[Dict] = []

    use_indices = trusted_indices if trusted_indices else unique_match_indices
    low_confidence = len(trusted_indices) == 0 and len(unique_match_indices) > 0
    no_eligible_data = len(unique_match_indices) == 0

    if no_eligible_data:
        near_miss = sorted(
            [cr for cr in combo_results if cr["size"] >= MIN_COMBO_SIZE and cr["discovery_count"] > 0],
            key=lambda x: x["discovery_count"],
            reverse=True,
        )[:15]
        return {
            "disclaimer": DISCLAIMER,
            "warning": (
                f"분석 반영 조합 없음: {MIN_COMBO_SIZE}개 이상 조합 중 "
                f"과거 발견 {MIN_DISCOVERY}회 이상인 패턴이 없습니다."
            ),
            "analysis_status": "no_eligible_data",
            "meta": {
                "total_rounds": total_rounds,
                "latest_round": latest_round,
                "trigger_round": trigger["round"],
                "trigger_numbers": nums,
                "trigger_bonus": bonus,
                "data_range": f"1~{latest_round}회",
            },
            "step1_combinations": {
                "total_combo_count": len(combos),
                "analysis_combo_count": 0,
                "by_size": {k: sum(1 for c in combos if len(c) == k) for k in range(1, 7)},
                "note": f"{MIN_COMBO_SIZE}개 이상 조합 + 발견 {MIN_DISCOVERY}회 이상만 분석 반영",
            },
            "step2_discovery": {
                "total_discovery_events": 0,
                "trusted_events": 0,
                "low_confidence_mode": False,
                "no_eligible_data": True,
                "min_combo_size": MIN_COMBO_SIZE,
                "min_discovery_threshold": MIN_DISCOVERY,
                "high_confidence_threshold": HIGH_CONFIDENCE_DISCOVERY,
                "excluded_single_combos": excluded_single,
                "excluded_low_discovery_combos": excluded_low_discovery,
                "unique_match_rounds_count": 0,
            },
            "step3_next_draw_collection": {
                "next_events_collected": 0,
                "with_bonus_total_picks": 0,
                "without_bonus_total_picks": 0,
            },
            "duplicate_pattern_analysis": [
                {
                    "combo": cr["combo"],
                    "size": cr["size"],
                    "discovery_count": cr["discovery_count"],
                    "next_collection_count": 0,
                    "trusted": False,
                    "excluded_reason": cr["excluded_reason"],
                }
                for cr in near_miss
            ],
            "top20_numbers": [],
            "final_ranking": [],
            "grades": {"S": [], "A": [], "B": []},
            "recommendations": {
                "stable": [],
                "balanced": [],
                "aggressive": [],
                "high_payout": [],
            },
            "evidence": {
                "match_rounds_used": 0,
                "trusted_only": False,
                "combo_search_sizes": f"{MIN_COMBO_SIZE}~6",
                "backtest_rounds": 0,
            },
        }

    for idx in use_indices:
        if idx + 1 >= len(draws):
            continue
        nxt = draws[idx + 1]
        next_events += 1
        next_main.extend(nxt["numbers"])
        next_with_bonus.extend(nxt["numbers"] + [nxt["bonus"]])
        event_meta.append(
            {
                "match_round": draws[idx]["round"],
                "next_round": nxt["round"],
                "distance": latest_round - draws[idx]["round"],
            }
        )

    # ── 4단계: 출현 통계 ───────────────────────────────────────────
    main_counter = Counter(next_main)
    total_main_picks = len(next_main)
    number_stats: List[Dict] = []
    for n in ALL_NUMBERS:
        cnt = main_counter.get(n, 0)
        trials = next_events
        rate = cnt / total_main_picks if total_main_picks else 0.0
        prob = cnt / trials if trials else 0.0
        ci_lo, ci_hi = _wilson_ci(cnt, trials)
        number_stats.append(
            {
                "number": n,
                "count": cnt,
                "rate": round(rate, 6),
                "probability": round(prob, 6),
                "ci_95_low": round(ci_lo, 6),
                "ci_95_high": round(ci_hi, 6),
            }
        )
    number_stats.sort(key=lambda x: x["count"], reverse=True)

    # ── 5단계: 최근성 가중치 ───────────────────────────────────────
    def weighted_counts(lam: float, window: int | None = None) -> Counter:
        wc: Counter = Counter()
        for ev in event_meta:
            if window and ev["distance"] > window:
                continue
            idx = round_to_idx.get(ev["match_round"])
            if idx is None or idx + 1 >= len(draws):
                continue
            w = math.exp(-lam * ev["distance"])
            for num in draws[idx + 1]["numbers"]:
                wc[num] += w
        return wc

    def backtest_lambda(lam: float) -> float:
        hits = []
        test_start = max(100, len(draws) - 300)
        for t_idx in range(test_start, len(draws) - 1):
            trig = draws[t_idx]["numbers"]
            wc: Counter = Counter()
            for i, d in enumerate(draws):
                if i >= t_idx:
                    break
                if set(trig) <= d["ns"] and i + 1 < len(draws):
                    dist = draws[t_idx]["round"] - d["round"]
                    w = math.exp(-lam * dist)
                    for num in draws[i + 1]["numbers"]:
                        wc[num] += w
            if not wc:
                continue
            top6 = {n for n, _ in wc.most_common(6)}
            actual = set(draws[t_idx + 1]["numbers"])
            hits.append(len(top6 & actual) / 6)
        return float(np.mean(hits)) if hits else 0.0

    lambda_scores = {lam: backtest_lambda(lam) for lam in LAMBDA_CANDIDATES}
    best_lambda = max(lambda_scores, key=lambda k: lambda_scores[k])
    recency_weighted = {
        str(w): {str(n): round(c, 4) for n, c in weighted_counts(best_lambda, w).most_common(15)}
        for w in RECENT_WINDOWS
    }

    # ── 6단계: 패턴 분석 ───────────────────────────────────────────
    pattern_stats: Dict = {}
    if next_events:
        samples = [draws[i + 1]["numbers"] for i in use_indices if i + 1 < len(draws)]
        flat = [n for s in samples for n in s]
        freq = Counter(flat)
        recent_flat = []
        for ev in event_meta[-min(100, len(event_meta)) :]:
            idx = round_to_idx.get(ev["match_round"])
            if idx is not None and idx + 1 < len(draws):
                recent_flat.extend(draws[idx + 1]["numbers"])

        carry = sum(1 for i in use_indices if i + 1 < len(draws) and set(draws[i]["numbers"]) & set(draws[i + 1]["numbers"]))

        pair_carry = 0
        triple_carry = 0
        for i in use_indices:
            if i + 1 >= len(draws):
                continue
            prev, nxt = set(draws[i]["numbers"]), set(draws[i + 1]["numbers"])
            pairs = list(combinations(draws[i]["numbers"], 2))
            if any(set(p) <= nxt for p in pairs):
                pair_carry += 1
            tris = list(combinations(draws[i]["numbers"], 3))
            if any(set(t) <= nxt for t in tris):
                triple_carry += 1
        consec_cnt = sum(
            1
            for s in samples
            if any(s[j + 1] - s[j] == 1 for j in range(5))
        )
        end_dup = sum(
            1
            for s in samples
            if max(Counter(n % 10 for n in s).values()) >= 2
        )
        mirrors = sum(
            1
            for s in samples
            for n in s
            if _mirror(n) in s
        )
        zone_dist = Counter()
        for s in samples:
            for lo, hi in ZONES:
                zone_dist[f"{lo}-{hi}"] += sum(1 for n in s if lo <= n <= hi)

        odd_ratios = [sum(1 for n in s if n % 2) / 6 for s in samples]
        low_ratios = [sum(1 for n in s if n <= 22) / 6 for s in samples]
        sums = [sum(s) for s in samples]
        distances = []
        for s in samples:
            for j in range(5):
                distances.append(s[j + 1] - s[j])

        last_seen = {n: -1 for n in ALL_NUMBERS}
        for i, d in enumerate(draws):
            for n in d["numbers"]:
                last_seen[n] = i
        long_absent = [n for n in ALL_NUMBERS if last_seen[n] < len(draws) - 20]
        expected = total_main_picks / 45 if total_main_picks else 0
        overheated = [n for n, c in freq.items() if c > expected * 1.5]
        cooled = [n for n in ALL_NUMBERS if freq.get(n, 0) < expected * 0.5]

        pattern_stats = {
            "sample_count": next_events,
            "frequencies": {
                "simple": _counter_items(freq, 10),
                "recent": _counter_items(Counter(recent_flat), 10),
            },
            "carryover": {
                "count": carry,
                "rate": round(carry / next_events, 4),
                "pair_rate": round(pair_carry / next_events, 4),
                "triple_rate": round(triple_carry / next_events, 4),
            },
            "rates": {
                "consecutive": round(consec_cnt / len(samples), 4),
                "same_ending": round(end_dup / len(samples), 4),
                "mirror_pairs": mirrors,
                "cluster_density": round(
                    sum(1 for s in samples if max(s) - min(s) <= 30) / len(samples), 4
                ),
            },
            "distribution": {
                "zones": [
                    {"zone": k, "count": int(v)} for k, v in sorted(zone_dist.items())
                ],
                "odd_ratio_avg": round(float(np.mean(odd_ratios)), 4),
                "low_high_ratio_avg": round(float(np.mean(low_ratios)), 4),
                "sum_mean": round(float(np.mean(sums)), 2),
                "sum_variance": round(float(np.var(sums)), 2),
                "sum_std": round(float(np.std(sums)), 2),
                "number_mean": round(float(np.mean(flat)), 2),
                "gap_mean": round(float(np.mean(distances)), 2) if distances else 0,
            },
            "number_states": {
                "long_absent": long_absent[:15],
                "overheated": overheated[:10],
                "cooled": cooled[:10],
            },
        }

    # ── 7단계: 연관 규칙 ───────────────────────────────────────────
    total_draws = len(draws) - 1
    assoc_rules: List[Dict] = []
    for k in (2, 3, 4, 5):
        for combo in combinations(nums, k):
            cset = set(combo)
            match_cnt = sum(
                1 for d in draws[:-1] if d["round"] < trigger["round"] and cset <= d["ns"]
            )
            if match_cnt < 3:
                continue
            next_cnt: Counter = Counter()
            for i, d in enumerate(draws):
                if d["round"] >= trigger["round"]:
                    break
                if cset <= d["ns"] and i + 1 < len(draws):
                    for num in draws[i + 1]["numbers"]:
                        next_cnt[num] += 1
            for num, cnt in next_cnt.most_common(5):
                support = match_cnt / total_draws
                conf = cnt / match_cnt
                num_support = sum(1 for d in draws if num in d["ns"]) / total_draws
                lift = conf / num_support if num_support else 0
                leverage = conf - num_support * support
                conviction = (1 - num_support) / (1 - conf) if conf < 1 else float("inf")
                assoc_rules.append(
                    {
                        "antecedent": list(combo),
                        "consequent": num,
                        "size": k,
                        "support": round(support, 6),
                        "confidence": round(conf, 6),
                        "lift": round(lift, 4),
                        "leverage": round(leverage, 6),
                        "conviction": round(conviction, 4) if conviction != float("inf") else 999,
                        "match_count": match_cnt,
                    }
                )
    assoc_rules.sort(key=lambda x: (x["confidence"], x["lift"]), reverse=True)

    # ── 8단계: 네트워크 ────────────────────────────────────────────
    adj = np.zeros((45, 45))
    for i in range(len(draws) - 1):
        nxt = [n for n in draws[i + 1]["numbers"] if 1 <= n <= 45]
        for a, b in combinations(nxt, 2):
            adj[a - 1, b - 1] += 1
            adj[b - 1, a - 1] += 1
    deg = _degree_centrality(adj)
    pr = _pagerank(adj)
    bc = _betweenness_approx(adj)
    ev = _eigenvector_centrality(adj)
    network_scores = {
        n: round(float(deg[n - 1] + pr[n - 1] + bc[n - 1] + ev[n - 1]) / 4, 6)
        for n in ALL_NUMBERS
    }

    # ── 9~10단계: 유사 회차 ────────────────────────────────────────
    similar: List[Dict] = []
    for d in draws:
        if d["round"] >= trigger["round"]:
            continue
        js = _jaccard(trigger_set, d["ns"])
        cs = _cosine(trigger_set, d["ns"])
        ov = _overlap_coef(trigger_set, d["ns"])
        avg = (js + cs + ov) / 3
        similar.append(
            {
                "round": d["round"],
                "jaccard": round(js, 4),
                "cosine": round(cs, 4),
                "overlap": round(ov, 4),
                "similarity": round(avg, 4),
            }
        )
    similar.sort(key=lambda x: x["similarity"], reverse=True)
    top_similar = similar[:100]
    similar_next: Counter = Counter()
    for s in top_similar:
        idx = next(i for i, d in enumerate(draws) if d["round"] == s["round"])
        if idx + 1 < len(draws):
            similar_next.update(draws[idx + 1]["numbers"])

    # ── 11단계: 보너스 분석 ────────────────────────────────────────
    bonus_counter = Counter()
    bonus_to_main = Counter()
    bonus_repeat = 0
    for idx in use_indices:
        if idx + 1 >= len(draws):
            continue
        nxt = draws[idx + 1]
        bonus_counter[nxt["bonus"]] += 1
        if nxt["bonus"] in nxt["numbers"]:
            bonus_to_main[nxt["bonus"]] += 1
        if idx + 2 < len(draws) and draws[idx + 2]["bonus"] == nxt["bonus"]:
            bonus_repeat += 1
    bonus_analysis = {
        "sample_count": next_events,
        "bonus_next_counts": _counter_items(bonus_counter, 10),
        "bonus_in_main_numbers": _counter_items(bonus_to_main, 10),
        "bonus_repeat_count": bonus_repeat,
        "main_number_top10": [
            {
                "number": s["number"],
                "count": s["count"],
                "rate": s["rate"],
                "probability": s["probability"],
            }
            for s in number_stats[:10]
        ],
    }

    # ── 12단계: 백테스트 ───────────────────────────────────────────
    bt_hits6, bt_hits10, bt_hits15, bt_avg = [], [], [], []
    test_from = max(100, len(draws) - 300)
    for t_idx in range(test_from, len(draws) - 1):
        trig_set = set(draws[t_idx]["numbers"])
        wc: Counter = Counter()
        for i, d in enumerate(draws):
            if i >= t_idx:
                break
            if trig_set <= d["ns"] and i + 1 < len(draws):
                for num in draws[i + 1]["numbers"]:
                    wc[num] += math.exp(-best_lambda * (draws[t_idx]["round"] - d["round"]))
        if not wc:
            continue
        ranked = [n for n, _ in wc.most_common(45)]
        actual = set(draws[t_idx + 1]["numbers"])
        top6, top10, top15 = set(ranked[:6]), set(ranked[:10]), set(ranked[:15])
        h6 = len(top6 & actual)
        bt_hits6.append(h6 / 6)
        bt_hits10.append(len(top10 & actual) / 6)
        bt_hits15.append(len(top15 & actual) / 6)
        bt_avg.append(h6)

    backtest = {
        "window_rounds": len(bt_hits6),
        "method": "rolling_validation_subset_match",
        "top6_hit_rate": round(float(np.mean(bt_hits6)), 4) if bt_hits6 else 0,
        "top10_hit_rate": round(float(np.mean(bt_hits10)), 4) if bt_hits10 else 0,
        "top15_hit_rate": round(float(np.mean(bt_hits15)), 4) if bt_hits15 else 0,
        "avg_hit_count": round(float(np.mean(bt_avg)), 4) if bt_avg else 0,
        "lambda_optimized": best_lambda,
        "lambda_scores": {str(k): round(v, 4) for k, v in lambda_scores.items()},
    }

    # ── 14~16단계: 앙상블 점수 ─────────────────────────────────────
    freq_raw = {n: main_counter.get(n, 0) for n in ALL_NUMBERS}
    rec_raw = {n: weighted_counts(best_lambda, 300).get(n, 0) for n in ALL_NUMBERS}
    follow_raw = freq_raw.copy()
    sim_raw = {n: similar_next.get(n, 0) for n in ALL_NUMBERS}
    cooc_raw = {n: sum(assoc_rules[i]["confidence"] for i, r in enumerate(assoc_rules) if r["consequent"] == n) for n in ALL_NUMBERS}
    net_raw = network_scores.copy()
    long_absent_list = pattern_stats.get("number_states", {}).get("long_absent", [])
    absent_raw = {n: 1.0 if n in long_absent_list else 0.0 for n in ALL_NUMBERS}
    bonus_raw = {n: bonus_counter.get(n, 0) for n in ALL_NUMBERS}
    carry_raw = {n: freq_raw.get(n, 0) if n in trigger_set else 0 for n in ALL_NUMBERS}
    bt_weight = backtest["top6_hit_rate"]

    components = {
        "frequency": _minmax_scale(freq_raw),
        "recency": _minmax_scale(rec_raw),
        "follow_up": _minmax_scale(follow_raw),
        "similar_pattern": _minmax_scale(sim_raw),
        "cooccurrence": _minmax_scale(cooc_raw),
        "network": _minmax_scale(net_raw),
        "long_absent": _minmax_scale(absent_raw),
        "bonus": _minmax_scale(bonus_raw),
        "carryover": _minmax_scale(carry_raw),
    }
    weights = {
        "frequency": 0.15,
        "recency": 0.12,
        "follow_up": 0.18,
        "similar_pattern": 0.10,
        "cooccurrence": 0.10,
        "network": 0.08,
        "long_absent": 0.07,
        "bonus": 0.05,
        "carryover": 0.05,
        "backtest": 0.10,
    }
    ensemble: Dict[int, float] = {}
    for n in ALL_NUMBERS:
        base = sum(components[k].get(n, 0) * weights[k] for k in components)
        ensemble[n] = round(base + bt_weight * weights["backtest"] * 100, 4)

    final_ranking = []
    sorted_nums = sorted(ensemble.items(), key=lambda x: x[1], reverse=True)
    for rank, (num, score) in enumerate(sorted_nums, 1):
        pct = rank / 45
        ns = next(s for s in number_stats if s["number"] == num)
        final_ranking.append(
            {
                "rank": rank,
                "number": num,
                "score": score,
                "probability": ns["probability"],
                "count": ns["count"],
                "rate": ns["rate"],
                "grade": _grade(pct),
            }
        )

    grades = {
        "S": [r["number"] for r in final_ranking if r["grade"] == "S"],
        "A": [r["number"] for r in final_ranking if r["grade"] == "A"],
        "B": [r["number"] for r in final_ranking if r["grade"] == "B"],
    }

    # ── 18~19단계: 추천 조합 ───────────────────────────────────────
    ranked_list = [{"number": r["number"], "score": r["score"]} for r in final_ranking]
    used: Set[Tuple[int, ...]] = set()
    recommendations: Dict[str, List[Dict]] = {
        "stable": [],
        "balanced": [],
        "aggressive": [],
        "high_payout": [],
    }
    bias_map = {
        "stable": "stable",
        "balanced": "stable",
        "aggressive": "aggressive",
        "high_payout": "high_payout",
    }
    for key in recommendations:
        for _ in range(5):
            picked = _pick_combo(ranked_list, used, bias_map[key])
            if not picked:
                break
            used.add(tuple(picked))
            sc = sum(ensemble[n] for n in picked) / 6
            risk = round(max(0.0, min(1.0, 1 - sc / 100)), 4)
            recommendations[key].append(
                {"numbers": picked, "expected_score": round(sc, 2), "risk": risk}
            )

    dup_patterns = sorted(
        [
            {
                "combo": cr["combo"],
                "size": cr["size"],
                "discovery_count": cr["discovery_count"],
                "next_collection_count": sum(
                    1
                    for i in use_indices
                    if set(cr["combo"]) <= draws[i]["ns"] and i + 1 < len(draws)
                ),
                "trusted": cr["trusted"],
            }
            for cr in combo_results
            if cr["size"] >= MIN_COMBO_SIZE and cr["included_in_analysis"]
        ],
        key=lambda x: x["discovery_count"],
        reverse=True,
    )[:30]

    warning = None
    if no_eligible_data:
        warning = (
            f"분석 반영 조합 없음: {MIN_COMBO_SIZE}개 이상 조합 중 "
            f"과거 발견 {MIN_DISCOVERY}회 이상인 패턴이 없습니다."
        )
    elif low_confidence:
        warning = (
            f"발견 {HIGH_CONFIDENCE_DISCOVERY}회 이상 신뢰 조합이 없어 "
            f"발견 {MIN_DISCOVERY}회 이상 조합으로 분석했습니다."
        )

    rec_total = sum(len(v) for v in recommendations.values())

    return {
        "disclaimer": DISCLAIMER,
        "warning": warning,
        "analysis_status": "ok",
        "meta": {
            "total_rounds": total_rounds,
            "latest_round": latest_round,
            "trigger_round": trigger["round"],
            "trigger_numbers": nums,
            "trigger_bonus": bonus,
            "data_range": f"1~{latest_round}회",
        },
        "step1_combinations": {
            "total_combo_count": len(combos),
            "analysis_combo_count": included_combo_count,
            "by_size": {k: sum(1 for c in combos if len(c) == k) for k in range(1, 7)},
            "note": f"{MIN_COMBO_SIZE}개 이상 조합 + 발견 {MIN_DISCOVERY}회 이상만 분석 반영",
        },
        "step2_discovery": {
            "total_discovery_events": len(unique_match_indices),
            "trusted_events": len(trusted_indices),
            "low_confidence_mode": low_confidence,
            "no_eligible_data": no_eligible_data,
            "min_combo_size": MIN_COMBO_SIZE,
            "min_discovery_threshold": MIN_DISCOVERY,
            "high_confidence_threshold": HIGH_CONFIDENCE_DISCOVERY,
            "excluded_single_combos": excluded_single,
            "excluded_low_discovery_combos": excluded_low_discovery,
            "unique_match_rounds_count": len(set(match_rounds)),
        },
        "step3_next_draw_collection": {
            "next_events_collected": next_events,
            "with_bonus_total_picks": len(next_with_bonus),
            "without_bonus_total_picks": len(next_main),
        },
        "duplicate_pattern_analysis": dup_patterns,
        "top20_numbers": [
            {
                "number": s["number"],
                "count": s["count"],
                "rate": s["rate"],
                "score": ensemble[s["number"]],
                "probability": s["probability"],
                "ci_95": [s["ci_95_low"], s["ci_95_high"]],
            }
            for s in number_stats[:20]
        ],
        "recency_analysis": {
            "optimized_lambda": best_lambda,
            "lambda_backtest_scores": backtest["lambda_scores"],
            "window_top_numbers": recency_weighted,
        },
        "pattern_analysis": pattern_stats,
        "association_rules_top20": assoc_rules[:20],
        "network_analysis": {
            "top_degree": sorted(
                [{"number": n, "score": round(float(deg[n - 1]), 4)} for n in ALL_NUMBERS],
                key=lambda x: x["score"],
                reverse=True,
            )[:10],
            "top_pagerank": sorted(
                [{"number": n, "score": round(float(pr[n - 1]), 4)} for n in ALL_NUMBERS],
                key=lambda x: x["score"],
                reverse=True,
            )[:10],
            "combined_network_scores": sorted(
                [{"number": n, "score": network_scores[n]} for n in ALL_NUMBERS],
                key=lambda x: x["score"],
                reverse=True,
            )[:15],
        },
        "similar_rounds_top20": top_similar[:20],
        "similar_round_next_frequency": similar_next.most_common(20),
        "bonus_analysis": bonus_analysis,
        "backtest": backtest,
        "ensemble_components": {k: dict(list(v.items())[:5]) for k, v in components.items()},
        "final_ranking": final_ranking,
        "grades": grades,
        "recommendations": recommendations,
        "recommendation_count": rec_total,
        "evidence": {
            "match_rounds_used": next_events,
            "trusted_only": not low_confidence,
            "combo_search_sizes": f"{MIN_COMBO_SIZE}~6",
            "backtest_rounds": backtest["window_rounds"],
        },
    }
