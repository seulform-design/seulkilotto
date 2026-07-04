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
    if odd not in VALID_ODD:
        return False
    # 구간(10단위) 분산 — 실제 당첨은 거의 항상 3개 이상 구간에 걸침.
    bands = {_decade_band(n) for n in nums}
    if strict_sum and len(bands) < 3:
        return False
    # 연속쌍 과다 방지 — 실측상 연속쌍 0~1개가 대부분(2개 이상은 드묾).
    s2 = sorted(nums)
    consec_pairs = sum(1 for i in range(5) if s2[i + 1] - s2[i] == 1)
    if strict_sum and consec_pairs > 2:
        return False
    return True


# ── 백테스트로 검증된 신호 블렌드(고빈도 추종 대신) ───────────────────
# 60회차×3호기 walk-forward(무작위 1.333)로 가중치를 그리드 최적화한 결과:
#   decade only 1.550 / +reversion(0.8) 1.583(최적) / +lean 은 오히려 저하(1.506).
# → '고빈도(hot) 추종'(검증상 음신호)뿐 아니라 '호기 고유편향(lean)'도 예측
#   정확도를 떨어뜨려 블렌드에서 제외. 최종: 구간별미출현(전역 최강) + 호기
#   평균회귀(미출현+저빈도, 호기 조건부)만 사용. lean 은 표시용으로만 계산.
_BLEND_W_DECADE = 1.0       # 구간별 미출현(보너스포함) — 최강 신호(lift+0.22)
_BLEND_W_REVERSION = 0.8    # 호기 평균회귀(미출현+저빈도) — 최적 가중
_BLEND_W_LEAN = 0.0         # 호기 고유편향 — 백테스트상 정확도 저하 → 미사용
_BLEND_BANDS: Tuple[Tuple[int, int, int], ...] = (
    (1, 10, 5), (11, 20, 5), (21, 30, 5), (31, 40, 5), (41, 45, 3),
)


def _decade_gap_scores(df: pd.DataFrame) -> Tuple[Dict[int, float], Dict[int, int]]:
    """구간별 미출현(보너스포함) 순위감쇠 점수 — 전역(최강 신호)."""
    from .gap_utils import last_seen_gaps

    gaps = last_seen_gaps(df, include_bonus=True)
    sc: Dict[int, float] = {n: 0.0 for n in ALL_NUMBERS}
    for lo, hi, k in _BLEND_BANDS:
        band = sorted(range(lo, hi + 1), key=lambda n: (-gaps[n], n))[:k]
        for rank, n in enumerate(band):
            sc[n] += 0.9 ** rank
    return sc, gaps


def _reversion_scores(sub: pd.DataFrame) -> Dict[int, float]:
    """호기 평균회귀 풀(미출현 0.6 + 저빈도 0.4) 순위감쇠 점수 — 호기별."""
    from .gap_utils import last_seen_gaps

    if len(sub) == 0:
        return {n: 0.0 for n in ALL_NUMBERS}
    gaps = last_seen_gaps(sub, include_bonus=True)
    freq: Dict[int, int] = {n: 0 for n in ALL_NUMBERS}
    for _, row in sub.iterrows():
        for c in NUMBER_COLUMNS:
            v = int(row[c])
            if 1 <= v <= 45:
                freq[v] += 1
    gap_rank = {n: r for r, n in enumerate(sorted(ALL_NUMBERS, key=lambda x: -gaps[x]))}
    freq_rank = {n: r for r, n in enumerate(sorted(ALL_NUMBERS, key=lambda x: freq[x]))}
    order = sorted(ALL_NUMBERS, key=lambda n: gap_rank[n] * 0.6 + freq_rank[n] * 0.4)
    sc: Dict[int, float] = {n: 0.0 for n in ALL_NUMBERS}
    for rank, n in enumerate(order[:20]):
        sc[n] = 0.9 ** rank
    return sc


def _lean_scores(dfm: pd.DataFrame, machine_id: int) -> Dict[int, float]:
    """호기 고유 편향 — 확정 라벨에서 이 호기가 기대보다 자주 낸 번호(z>0)만
    [0,1] 로 정규화해 소폭 가점. 이게 '호기 예측력' 성분."""
    sub = _confirmed_subset(dfm, machine_id)
    n = len(sub)
    sc: Dict[int, float] = {x: 0.0 for x in ALL_NUMBERS}
    if n == 0:
        return sc
    freq: Dict[int, int] = {x: 0 for x in ALL_NUMBERS}
    for _, row in sub.iterrows():
        for c in NUMBER_COLUMNS:
            v = int(row[c])
            if 1 <= v <= 45:
                freq[v] += 1
    exp = n * 6 / 45.0
    zmax = 0.0
    zs: Dict[int, float] = {}
    for x in ALL_NUMBERS:
        z = (freq[x] - exp) / (exp ** 0.5) if exp > 0 else 0.0
        zs[x] = max(0.0, z)
        zmax = max(zmax, zs[x])
    if zmax > 0:
        for x in ALL_NUMBERS:
            sc[x] = zs[x] / zmax
    return sc


def blended_number_scores(
    df: pd.DataFrame, dfm: pd.DataFrame, machine_id: int
) -> Dict[str, Dict[int, float]]:
    """검증된 3신호 블렌드 점수 + 성분 분해 반환."""
    decade, _gaps = _decade_gap_scores(df)
    sub = dfm[dfm["machine_id"] == machine_id]
    reversion = _reversion_scores(sub)
    lean = _lean_scores(dfm, machine_id)
    blended: Dict[int, float] = {}
    for n in ALL_NUMBERS:
        blended[n] = (
            _BLEND_W_DECADE * decade[n]
            + _BLEND_W_REVERSION * reversion[n]
            + _BLEND_W_LEAN * lean[n]
        )
    return {"blended": blended, "decade": decade, "reversion": reversion, "lean": lean}


def _weighted_pick(rng: random.Random, cands: List[int], scores: Dict[int, float]) -> int:
    """점수 비례 가중 추출(점수 0 이어도 최소기회)."""
    weights = [scores.get(n, 0.0) + 0.15 for n in cands]
    total = sum(weights)
    r = rng.uniform(0, total)
    acc = 0.0
    for n, w in zip(cands, weights):
        acc += w
        if r <= acc:
            return n
    return cands[-1]


def _build_scored_combo(
    rng: random.Random,
    pool: List[int],
    scores: Dict[int, float],
    strict: bool,
) -> Optional[List[int]]:
    """상위 풀에서 점수 가중으로 6개 — 구간분산/홀짝/합/연속 필터 통과분만."""
    chosen: Set[int] = set()
    cand_pool = list(pool)
    guard = 0
    while len(chosen) < 6 and guard < 60:
        guard += 1
        remain = [n for n in cand_pool if n not in chosen]
        if not remain:
            remain = [n for n in ALL_NUMBERS if n not in chosen]
        chosen.add(_weighted_pick(rng, remain, scores))
    nums = sorted(chosen)
    return nums if _is_valid(nums, strict_sum=strict) else None


def generate_round_recommendations(
    analysis: Dict,
    seed: Optional[int] = None,
    n_games: int = NUM_GAMES,
    scores: Optional[Dict[int, float]] = None,
    pool: Optional[List[int]] = None,
) -> List[Dict]:
    if analysis.get("draw_count", 0) == 0:
        return []

    rng = random.Random(seed)
    # 검증된 블렌드 점수/풀이 있으면 그것으로 구성(기본 경로).
    if scores is None:
        # 폴백: 예전 방식(있는 풀). 정상 경로에서는 항상 scores 가 전달된다.
        scores = {n: 1.0 for n in analysis.get("_hot_pool", ALL_NUMBERS)}
    if not pool:
        pool = sorted(ALL_NUMBERS, key=lambda n: -scores.get(n, 0.0))[:18]

    games: List[List[int]] = []
    for strict in (True, False):
        attempts = 0
        cap = MAX_GENERATION_ATTEMPTS if strict else 2000
        while len(games) < n_games and attempts < cap:
            attempts += 1
            combo = _build_scored_combo(rng, pool, scores, strict=strict)
            if combo is None or combo in games:
                continue
            games.append(combo)
        if len(games) >= n_games:
            break

    def _cover(g: List[int]) -> int:
        return sum(1 for n in g if n in set(pool[:12]))

    return [
        {
            "numbers": g,
            "sum_total": sum(g),
            "odd_count": sum(1 for n in g if n % 2 == 1),
            "even_count": sum(1 for n in g if n % 2 == 0),
            "signal_hits": _cover(g),  # 상위신호 12개 중 몇 개 포함
        }
        for g in games
    ]


_RECO_BT_CACHE: Dict[Tuple[int, int, int], Dict] = {}


def backtest_recommendation(
    dfm: pd.DataFrame, machine_id: int, rounds: int = 30, top_k: int = 10
) -> Dict:
    """개선 엔진(검증 블렌드) vs 기존 엔진(고빈도 추종)을 walk-forward 로 비교.
    각 회차 R 은 R 직전 데이터만으로 상위 top_k 를 뽑아 실제 당첨 6개와 겹친 수를
    측정(미래 누수 없음). 반환: 두 방식의 평균 적중·무작위 대비 lift.

    단일 순방향 패스로 누적 상태(전역 미출현·호기별 미출현/빈도)를 갱신하며
    테스트 회차에서 예측을 뽑는다(회차마다 재계산하던 iterrows 제거 → 60회
    백테스트 16s→<1s)."""
    latest = int(dfm["round"].max())
    key = (latest, machine_id, rounds)
    if key in _RECO_BT_CACHE:
        return _RECO_BT_CACHE[key]

    ordered = dfm.sort_values("round")
    rounds_list = ordered["round"].astype(int).tolist()
    mats = [[int(row[c]) for c in NUMBER_COLUMNS] for _, row in ordered.iterrows()]
    bons = [int(b) if not pd.isna(b) else 0 for b in ordered["bonus"].tolist()] \
        if "bonus" in ordered.columns else [0] * len(mats)
    machs = ordered["machine_id"].astype(int).tolist()

    N = len(rounds_list)
    floor_round = rounds_list[0] + 50 if rounds_list else 0
    test_set = set([r for r in rounds_list if r >= floor_round][-rounds:])
    base = round(top_k * 6 / 45, 3)

    # 누적 상태 (전역 draw index gi 기준)
    last_global = {n: -1 for n in ALL_NUMBERS}     # 보너스 포함 마지막 출현 gi
    last_mach = {n: -1 for n in ALL_NUMBERS}       # 이 호기 subset 마지막 출현(호기 draw index)
    freq_mach = {n: 0 for n in ALL_NUMBERS}
    mcount = 0                                       # 이 호기 누적 draw 수

    def _decade_from(lastseen: Dict[int, int], now: int) -> Dict[int, float]:
        sc = {n: 0.0 for n in ALL_NUMBERS}
        for lo, hi, k in _BLEND_BANDS:
            band = sorted(range(lo, hi + 1),
                          key=lambda n: (-(now - lastseen[n]), n))[:k]
            for rank, n in enumerate(band):
                sc[n] += 0.9 ** rank
        return sc

    new_hits: List[int] = []
    old_hits: List[int] = []
    new_3plus = old_3plus = 0
    for gi in range(N):
        r = rounds_list[gi]
        actual = set(mats[gi])
        is_test = r in test_set and gi >= 50
        if is_test:
            # 개선 엔진: decade(전역 미출현) + reversion(호기 미출현0.6+저빈도0.4)
            dec = _decade_from(last_global, gi)
            if mcount > 0:
                gap_rank = {n: rk for rk, n in enumerate(
                    sorted(ALL_NUMBERS, key=lambda x: -(mcount - last_mach[x])))}
                freq_rank = {n: rk for rk, n in enumerate(
                    sorted(ALL_NUMBERS, key=lambda x: freq_mach[x]))}
                order = sorted(ALL_NUMBERS,
                               key=lambda n: gap_rank[n] * 0.6 + freq_rank[n] * 0.4)
                rev = {n: 0.0 for n in ALL_NUMBERS}
                for rk, n in enumerate(order[:20]):
                    rev[n] = 0.9 ** rk
            else:
                rev = {n: 0.0 for n in ALL_NUMBERS}
            blended = {n: _BLEND_W_DECADE * dec[n] + _BLEND_W_REVERSION * rev[n]
                       for n in ALL_NUMBERS}
            new_top = sorted(ALL_NUMBERS, key=lambda n: -blended[n])[:top_k]
            nh = len(set(new_top) & actual)
            new_hits.append(nh); new_3plus += nh >= 3
            # 기존 엔진: 이 호기 고빈도 상위
            old_top = sorted(ALL_NUMBERS, key=lambda n: (-freq_mach[n], n))[:top_k]
            oh = len(set(old_top) & actual)
            old_hits.append(oh); old_3plus += oh >= 3
        # 상태 갱신 (이 회차를 prior 에 반영)
        for v in mats[gi]:
            if 1 <= v <= 45:
                last_global[v] = gi
        if 1 <= bons[gi] <= 45:
            last_global[bons[gi]] = gi
        if machs[gi] == machine_id:
            for v in mats[gi]:
                if 1 <= v <= 45:
                    last_mach[v] = mcount
                    freq_mach[v] += 1
            if 1 <= bons[gi] <= 45:
                last_mach[bons[gi]] = mcount
            mcount += 1

    n = len(new_hits) or 1
    new_avg = round(sum(new_hits) / n, 3)
    old_avg = round(sum(old_hits) / n, 3)
    result = {
        "available": bool(new_hits),
        "rounds_tested": len(new_hits),
        "top_k": top_k,
        "random_baseline": base,
        "new_avg_hits": new_avg,
        "new_lift": round(new_avg - base, 3),
        "new_3plus": new_3plus,
        "old_avg_hits": old_avg,
        "old_lift": round(old_avg - base, 3),
        "old_3plus": old_3plus,
        "improvement": round(new_avg - old_avg, 3),
    }
    _RECO_BT_CACHE[key] = result
    if len(_RECO_BT_CACHE) > 12:
        _RECO_BT_CACHE.pop(next(iter(_RECO_BT_CACHE)))
    return result


def build_round_recommendation(
    df: pd.DataFrame,
    machine_id: Optional[int] = None,
    seed: Optional[int] = None,
    with_backtest: bool = True,
) -> Dict:
    from .machine_registry import coverage, resolve

    df = attach_machine_column(df)
    next_round, next_date, auto_machine = predict_next_round(df)
    target = machine_id if machine_id in (1, 2, 3) else auto_machine

    stats = analyze_machine(df, target)

    # 검증된 신호 블렌드로 점수/풀 구성 후 조합 생성(고빈도 추종 폐기).
    comp = blended_number_scores(df, df, target)
    blended = comp["blended"]
    pool = sorted(ALL_NUMBERS, key=lambda n: (-blended[n], n))[:18]
    combos = generate_round_recommendations(stats, seed=seed, scores=blended, pool=pool)

    public_stats = {k: v for k, v in stats.items() if not k.startswith("_")}

    # 상위 신호 번호 breakdown(성분별 기여) — 정밀 근거 표시용.
    # lean 은 블렌드 미사용(가중 0, 백테스트상 저하)이라 근거에서 제외.
    from .gap_utils import last_seen_gaps

    gap_bonus = last_seen_gaps(df, include_bonus=True)
    top_scored = [
        {
            "number": n,
            "score": round(blended[n], 3),
            "decade": round(comp["decade"][n], 3),
            "reversion": round(comp["reversion"][n], 3),
            "gap": gap_bonus[n],  # 보너스포함 미출현 회수(근거)
        }
        for n in pool
    ]

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
        "top_scored": top_scored,
        "backtest": backtest_recommendation(df, target, rounds=60) if with_backtest else None,
        "warning": warning,
        "filter_rule": "총합 100~175, 홀짝 2:4|3:3|4:2, 구간 3개+ 분산, 연속쌍 ≤2",
        "compose_rule": "검증 블렌드: 구간별 미출현(전역 최강) + 호기 평균회귀 — 백테스트 최적 가중",
    }
