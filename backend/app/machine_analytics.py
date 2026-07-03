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


def _machine_ball_weights(sub: pd.DataFrame) -> Dict[int, float]:
    """해당 호기 실제 추첨 이력의 번호별 출현 빈도 → 볼 가중치(라플라스 스무딩).
    이 호기가 과거에 자주 뽑은 번호일수록 볼이 더 잘 나오도록 '성향'을 부여한다."""
    counts: Dict[int, int] = {n: 0 for n in ALL_NUMBERS}
    for _, row in sub.iterrows():
        for c in NUMBER_COLUMNS:
            v = int(row[c])
            if 1 <= v <= 45:
                counts[v] += 1
        b = int(row["bonus"]) if "bonus" in row and not pd.isna(row["bonus"]) else 0
        if 1 <= b <= 45:
            counts[b] += 1
    # 스무딩: 모든 번호에 기회. 표본 없으면 균등.
    return {n: counts[n] + 1.0 for n in ALL_NUMBERS}


def _weighted_draw_without_replacement(
    weights: Dict[int, float], k: int, rng: random.Random
) -> List[int]:
    """가중치 기반 비복원 추출 — 실제 로또 볼처럼 하나씩 뽑되, 그 호기가 과거
    자주 낸 번호일수록 뽑힐 확률이 높은 '호기 특성'을 반영한다."""
    pool = dict(weights)
    out: List[int] = []
    for _ in range(min(k, len(pool))):
        total = sum(pool.values())
        r = rng.uniform(0, total)
        acc = 0.0
        pick = next(iter(pool))
        for n, w in pool.items():
            acc += w
            if r <= acc:
                pick = n
                break
        out.append(pick)
        del pool[pick]
    return out


# ── 호기 성향 프로파일 (역대 실측 누적 데이터 역산) ───────────────────
# 동행복권 추첨기 3기는 공정관리 대상이라 실측상 호기 예측력은 사실상 중립
# (lift ~0). 아래 프로파일은 '예측'이 아니라 969회(262~1230, 100% 라벨검증)
# 누적 데이터에서 각 호기가 상대적으로 어느 쪽으로 미세하게 기울었는지를
# 정직하게 역산한 '성향 연출'이다. 볼 가중치(_machine_ball_weights)와 함께
# 같은 실측 데이터를 근거로 하므로 시뮬레이션과 프로파일이 일관된다.
_DECADE_LABELS = ["1-10", "11-20", "21-30", "31-40", "41-45"]


def _decade_band(n: int) -> int:
    return min((n - 1) // 10, 4)


def _confirmed_subset(dfm: pd.DataFrame, machine_id: int) -> pd.DataFrame:
    """추정(estimated)을 제외하고 '확정(confirmed)' 라벨 회차만 — 실측 근거."""
    mask = (dfm["machine_id"] == machine_id) & (dfm.get("machine_source") == "confirmed")
    return dfm[mask]


def _global_prev_map(dfm: pd.DataFrame) -> Dict[int, Set[int]]:
    """회차 → 그 회차의 (당첨6+보너스) 집합 — 이월수 판정용 전역 룩업.
    이월은 '직전 회차가 어느 호기였든' 그 번호가 되돌아왔는지를 본다."""
    out: Dict[int, Set[int]] = {}
    for _, row in dfm.iterrows():
        rd = int(row["round"])
        nums = {int(row[c]) for c in NUMBER_COLUMNS}
        bonus = int(row["bonus"]) if not pd.isna(row.get("bonus")) else 0
        if 1 <= bonus <= 45:
            nums.add(bonus)
        out[rd] = nums
    return out


def _row_metrics(sub: pd.DataFrame, prev_map: Optional[Dict[int, Set[int]]] = None) -> Dict[str, float]:
    """부분집합의 성향 지표를 한 번에 계산. prev_map(전역 회차→번호집합)이 있으면
    이월수를 직전 회차(호기 무관) 기준으로 판정한다."""
    n = len(sub)
    if n == 0:
        return {}
    dec = [0] * 5
    freq: Dict[int, int] = {x: 0 for x in ALL_NUMBERS}
    consec = samelast = high = 0
    sums: List[int] = []
    odds: List[int] = []
    carry = carry_den = 0
    rows = sub.sort_values("round")
    for _, row in rows.iterrows():
        rd = int(row["round"])
        nums = sorted(int(row[c]) for c in NUMBER_COLUMNS)
        for x in nums:
            freq[x] += 1
            dec[_decade_band(x)] += 1
            if x >= 31:
                high += 1
        if any(nums[i + 1] - nums[i] == 1 for i in range(5)):
            consec += 1
        last = {}
        for x in nums:
            last[x % 10] = last.get(x % 10, 0) + 1
        if any(v >= 2 for v in last.values()):
            samelast += 1
        sums.append(sum(nums))
        odds.append(sum(1 for x in nums if x % 2 == 1))
        if prev_map is not None and (rd - 1) in prev_map:
            carry_den += 1
            if set(nums) & prev_map[rd - 1]:
                carry += 1
    tot = sum(dec) or 1
    return {
        "n": n,
        "freq": freq,
        "decade_pct": [round(d / tot * 100, 1) for d in dec],
        "consec_rate": consec / n,
        "samelast_rate": samelast / n,
        "carry_rate": (carry / carry_den) if carry_den else 0.0,
        "high_avg": high / n,             # 31~45 평균 개수
        "avg_sum": sum(sums) / n,
        "avg_odd": sum(odds) / n,
    }


def _persona(mid: int, m: Dict[str, float], base: Dict[str, float]) -> Tuple[str, str]:
    """실측 편차에서 성향 라벨/한줄평 도출 (하드코딩 아님, 데이터 우선)."""
    dec = m["decade_pct"]
    dom = max(range(5), key=lambda b: dec[b] - base["decade_pct"][b])
    band_word = {0: "저번(1~10)", 1: "중저번(11~20)", 2: "중번(21~30)",
                 3: "고번(31~40)", 4: "끝번(41~45)"}[dom]
    # 가장 두드러진 부가 성향
    cand = [
        ("연번", m["consec_rate"] - base["consec_rate"]),
        ("동끝수", m["samelast_rate"] - base["samelast_rate"]),
        ("이월수", m["carry_rate"] - base["carry_rate"]),
        ("고번", (m["high_avg"] - base["high_avg"]) / 6.0),
    ]
    trait, _ = max(cand, key=lambda x: x[1])
    label = f"{band_word.split('(')[0]}·{trait}형"
    tag = {
        "연번": "연속번호가 상대적으로 잦은 흐름",
        "동끝수": "같은 끝수(예 3·13·23)가 잘 뭉치는 흐름",
        "이월수": "직전 회차 번호가 되돌아오는 이월이 잦은 흐름",
        "고번": "30번대 위 묵직한 번호에 무게가 실리는 흐름",
    }[trait]
    return label, f"{band_word} 대가 상대적으로 강하고, {tag}."


def machine_profile(dfm: pd.DataFrame, machine_id: int) -> Dict:
    """호기별 실측 성향 프로파일 — 역대 누적(확정 라벨) 데이터에서 역산.
    반환은 프론트 표시용(정직 캡션 포함)."""
    prev_map = _global_prev_map(dfm)
    base = _row_metrics(dfm[dfm.get("machine_source") == "confirmed"], prev_map)
    m = _row_metrics(_confirmed_subset(dfm, machine_id), prev_map)
    if not m or not base:
        return {}
    freq = m["freq"]
    n = m["n"]
    exp = n * 6 / 45.0
    zdev = sorted(
        ((round((freq[x] - exp) / (exp ** 0.5), 2), x) for x in ALL_NUMBERS),
        reverse=True,
    )
    hot = [{"number": x, "z": z} for z, x in zdev[:6]]
    cold = [{"number": x, "z": z} for z, x in zdev[-6:][::-1]]
    label, tagline = _persona(machine_id, m, base)

    def dv(cur: float, ref: float) -> float:
        return round((cur - ref) * 100, 1)

    traits = [
        {"key": "고번강세", "label": "고번(31~45) 평균",
         "value": round(m["high_avg"], 2), "baseline": round(base["high_avg"], 2),
         "unit": "개", "delta": round(m["high_avg"] - base["high_avg"], 2)},
        {"key": "연번", "label": "연번 출현율",
         "value": round(m["consec_rate"] * 100, 1), "baseline": round(base["consec_rate"] * 100, 1),
         "unit": "%", "delta": dv(m["consec_rate"], base["consec_rate"])},
        {"key": "동끝수", "label": "동끝수 뭉침율",
         "value": round(m["samelast_rate"] * 100, 1), "baseline": round(base["samelast_rate"] * 100, 1),
         "unit": "%", "delta": dv(m["samelast_rate"], base["samelast_rate"])},
        {"key": "이월수", "label": "이월수 출현율",
         "value": round(m["carry_rate"] * 100, 1), "baseline": round(base["carry_rate"] * 100, 1),
         "unit": "%", "delta": dv(m["carry_rate"], base["carry_rate"])},
    ]
    # 절대 편차가 큰 순으로 정렬(그 호기에서 가장 두드러진 지표가 위로)
    traits.sort(key=lambda t: -abs(t["delta"]))
    return {
        "machine_id": machine_id,
        "confirmed_count": n,
        "persona": label,
        "tagline": tagline,
        "decade_pct": m["decade_pct"],
        "decade_labels": _DECADE_LABELS,
        "hot": hot,
        "cold": cold,
        "avg_sum": round(m["avg_sum"], 1),
        "avg_odd": round(m["avg_odd"], 2),
        "traits": traits,
        "honesty": (
            "공정관리 추첨기라 호기별 예측력은 실측상 중립(lift~0)입니다. "
            "위 수치는 969회 누적에서 역산한 미세 성향(통계적 유희)일 뿐, "
            "다음 회차 확률을 바꾸지 않습니다."
        ),
    }


def simulate_machine_draw(
    df: pd.DataFrame, machine_id: int, seed: Optional[int] = None
) -> Dict:
    """호기별 '볼 추첨기' 시뮬레이터 — 해당 호기의 실제 데이터 특징(번호 출현
    성향)을 반영해 볼 7개(당첨 6 + 보너스 1)를 추첨 순서대로 뽑는다.

    정직: 실제 로또는 균등확률(각 6-튜플 1/8,145,060)이며, 본 시뮬은 그 호기의
    '과거 성향'을 재현한 연출일 뿐 실제 확률을 바꾸지 않는다.
    """
    if machine_id not in (1, 2, 3):
        machine_id = 1
    dfm = attach_machine_column(df)
    sub = dfm[dfm["machine_id"] == machine_id]
    draw_count = int(len(sub))

    # 각 호기의 실제 추첨 데이터 특성(번호 출현 성향)을 반영해 볼 7개를 하나씩
    # 뽑는다. 실제 방송처럼 볼을 순서대로 추첨하되, 그 호기가 과거 자주 낸
    # 번호일수록 확률이 높다(라플라스 스무딩으로 모든 번호에 기회).
    weights = _machine_ball_weights(sub)
    rng = random.Random(seed)
    order = _weighted_draw_without_replacement(weights, 7, rng)
    main_order = order[:6]
    bonus = order[6] if len(order) > 6 else 0
    main_sorted = sorted(main_order)

    # 이 호기가 상대적으로 자주 나오는 '시그니처' 번호 (특성)
    total_w = sum(weights.values()) or 1.0
    expected = total_w / 45.0
    signature = sorted(
        ALL_NUMBERS, key=lambda n: (-(weights[n] - expected), n)
    )[:6]
    sums = []
    odds = []
    for _, row in sub.iterrows():
        nums = [int(row[c]) for c in NUMBER_COLUMNS]
        sums.append(sum(nums))
        odds.append(sum(1 for n in nums if n % 2 == 1))

    return {
        "machine_id": machine_id,
        "draw_count": draw_count,
        "draw_order": main_order,      # 추첨 순서(연출용)
        "bonus": bonus,
        "numbers": main_sorted,        # 정렬된 당첨 6
        "sum_total": sum(main_sorted),
        "odd_count": sum(1 for n in main_sorted if n % 2 == 1),
        "even_count": sum(1 for n in main_sorted if n % 2 == 0),
        "signature_numbers": signature,
        "avg_sum": round(sum(sums) / len(sums), 1) if sums else 0.0,
        "avg_odd": round(sum(odds) / len(odds), 2) if odds else 0.0,
        "profile": machine_profile(dfm, machine_id),   # 실측 역산 성향 프로파일
        "seed": seed,
        "disclaimer": (
            f"{machine_id}호기의 실제 추첨 {draw_count}회 데이터 특성(번호 출현 성향)을 "
            "반영한 시뮬레이터입니다. 실제 로또 1등 확률(1/8,145,060)은 변하지 않습니다."
        ),
    }


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
