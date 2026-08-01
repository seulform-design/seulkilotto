"""복기 역산 검증 — 당첨번호가 각 신호에서 어디에 있었는지 정직하게 되짚는다.

사용자 관찰: 강수/기대 그리드(넓은 그물, ~28개)는 당첨 6개를 다 담았는데 최종
top-6 집중 픽은 대부분 놓친다. 왜인지를 데이터로 보여준다.

핵심 발견(실측 1233): 당첨번호는 '양쪽 지지' 상위가 아니라 **중간 지지대**에 몰렸고,
가장 많이 산 번호(고지지 최상위)는 당첨되지 않았다 — 티켓 빈도는 추첨과 무관하기
때문이다. 그래서 '집중' 은 실패하고 '넓은 커버리지' 만 잡는다.

⚠️ 이 리포트는 확률을 올리지 않는다. 어떤 신호도 당첨을 top-6 로 집중시키지
못한다는 사실을 정직하게 드러내, 헛된 '집중 예측' 대신 커버리지 전략을 쓰게 한다.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any, Dict, List

COVERAGE_KS = [6, 10, 15, 18, 24, 30]

# 통계적 유의성 — 소표본에서 lift 를 과신하지 않도록 p값·신뢰구간을 병기한다.
SMALL_SAMPLE_ROUNDS = 5  # 이 미만이면 소표본 경고(우연 가능성 높음)


def _normal_sf(z: float) -> float:
    """표준정규 상측 꼬리 P(Z >= z) — scipy 없이 erfc 로."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def _coverage_significance(total_hits: float, rounds: int, k: int) -> Dict[str, Any]:
    """상위 K 커버리지가 균등무작위를 유의하게 초과하나 — 회차별 초기하 합의 정규근사.

    귀무가설(H0): 상위 K 는 무작위 K-부분집합. 한 회차 적중수 ~ Hypergeometric(N=45,
    당첨=6, 추출=K), 평균 K·6/45, 분산 K·(6/45)(39/45)((45-K)/44). 회차 독립 합산 후
    (관측-기대)/표준편차 로 z, 상측 p값. 로또 i.i.d. 이므로 확률을 올리는 게 아니라 '이
    커버리지가 우연 이상인지'만 정직하게 검정한다. 소표본은 significant 라도 우연 가능."""
    if rounds <= 0 or k <= 0 or k >= 45:
        return {"total_hits": int(total_hits), "expected": 0.0, "z": 0.0, "p_value": 1.0,
                "lift": 0.0, "significant": False, "small_sample": True}
    p = 6.0 / 45.0
    exp_per = k * p
    var_per = k * p * (1.0 - p) * ((45.0 - k) / 44.0)
    expected = rounds * exp_per
    variance = rounds * var_per
    sd = math.sqrt(variance) if variance > 0 else 0.0
    z = (total_hits - expected) / sd if sd > 0 else 0.0
    p_value = _normal_sf(z)
    mean_hit = total_hits / rounds
    ci_half = 1.96 * math.sqrt(var_per / rounds) if (rounds > 0 and var_per > 0) else 0.0
    small = rounds < SMALL_SAMPLE_ROUNDS
    return {
        "total_hits": int(round(total_hits)),
        "expected": round(expected, 3),
        "mean_hit": round(mean_hit, 3),
        "ci95": [round(max(0.0, mean_hit - ci_half), 3), round(mean_hit + ci_half, 3)],
        "z": round(z, 3),
        "p_value": round(p_value, 4),
        "lift": round(total_hits / expected, 3) if expected > 0 else 0.0,
        # 소표본에선 유의해도 우연일 수 있어 significant 를 보수적으로: 소표본이면 False 로 억제.
        "significant": bool(p_value < 0.05 and total_hits > expected and not small),
        "small_sample": small,
    }


def _rank_signal(
    values: Dict[int, float],
    tiebreak: Dict[int, float] | None = None,
    tiebreak2: Dict[int, float] | None = None,
) -> List[int]:
    """값 내림차순으로 45개 번호를 정렬.

    동률 깨기(feature/round/pattern 과 동일 4단계):
      1) values 내림차순
      2) tiebreak(총 등장 total_freq) 내림차순
      3) tiebreak2(자동 빈도 auto_freq) 내림차순
      4) 번호 오름차순

    ⚠️ tiebreak 없이 번호 순서로만 동률을 깨면 인덱스 편향(낮은 번호가 임의로 상위)이
    생긴다. feature 엔진은 (-support, -total, -auto, n) — 같은 support 신호가 엔진마다
    다르게 정렬되던 불일치를 없애기 위해 여기서도 total·auto 를 넘겨 맞춘다.
    """
    if tiebreak is None:
        return sorted(range(1, 46), key=lambda n: (-values.get(n, 0.0), n))
    if tiebreak2 is None:
        return sorted(
            range(1, 46),
            key=lambda n: (-values.get(n, 0.0), -tiebreak.get(n, 0.0), n),
        )
    return sorted(
        range(1, 46),
        key=lambda n: (
            -values.get(n, 0.0),
            -tiebreak.get(n, 0.0),
            -tiebreak2.get(n, 0.0),
            n,
        ),
    )


# 구간(10단위) — 균형 커버리지의 기준. balanced 신호와 동일 관례(min(4,(n-1)//10)):
# d0=1~10, d1=11~20, d2=21~30, d3=31~40, d4=41~45.
DECADE_LABELS = ["1~10", "11~20", "21~30", "31~40", "41~45"]


def _decade(n: int) -> int:
    return min(4, (int(n) - 1) // 10)


def _balance_expand(
    order: List[int], core: List[int], present: set, size: int = 18
) -> List[int]:
    """확장(넓은 그물) 세트가 티켓에 후보가 있는 5개 구간을 모두 커버하도록 보정한다.
    core 는 항상 포함(core ⊂ expand 유지) → 아직 대표 없는 '후보 있는 구간'을 랭킹 상위로
    1개씩 채운 뒤 → 나머지는 신호 랭킹 순으로 채운다. 확률을 올리지 않는다 — 당첨이 어느
    구간에 떨어져도 그물이 비지 않게 하는 '커버리지 폭(분산)' 보정. 티켓에 아예 없는 구간은
    억지로 채우지 않는다(그 구간은 티켓 기반으론 못 잡음 = 정직한 한계)."""
    result: List[int] = [n for n in order if n in core]  # 랭킹에 있는 core 우선
    seen = set(result)
    covered = {_decade(n) for n in result if n in present}
    for d in range(5):  # 1차 — 후보 있는데 대표 없는 구간을 랭킹 상위로 1개씩
        if d in covered:
            continue
        for n in order:
            if n not in seen and n in present and _decade(n) == d:
                result.append(n)
                seen.add(n)
                covered.add(d)
                break
    for n in order:  # 2차 — 남은 자리를 랭킹 순으로
        if len(result) >= size:
            break
        if n not in seen:
            result.append(n)
            seen.add(n)
    return result[:size]


def _decade_balance_info(
    balanced: List[int], raw: List[int], present: set
) -> Dict[str, Any]:
    """구간 균형 진단 — 보정 세트의 구간 분포 + 보정으로 새로 채운 구간 + 티켓에
    후보가 아예 없는(구조적 미포착) 구간 + raw→balanced 교체 감사."""
    present_decades = {_decade(n) for n in present}
    raw_decades = {_decade(n) for n in raw}
    bal_decades = {_decade(n) for n in balanced}
    raw_set = set(raw)
    bal_set = set(balanced)
    return {
        "spread": {DECADE_LABELS[d]: sum(1 for n in balanced if _decade(n) == d) for d in range(5)},
        "filled_decades": [
            DECADE_LABELS[d] for d in range(5)
            if d in present_decades and d not in raw_decades and d in bal_decades
        ],
        "empty_decades": [DECADE_LABELS[d] for d in range(5) if d not in present_decades],
        # 구간 보정이 raw top18 멤버십을 바꿨는지 — 적중 하락 원인 추적.
        "displaced": sorted(raw_set - bal_set),
        "promoted": sorted(bal_set - raw_set),
    }


EXPAND_MODE_LABELS = {
    "boe_balanced": "전엔진 min-rank + 구간균형",
    "boe_raw": "전엔진 min-rank (균형 없음)",
    "single_balanced": "단일신호 topK + 구간균형",
    "single_raw": "단일신호 topK",
    "merge_balanced": "단일∪min-rank 병합 + 구간균형",
    "merge_raw": "단일∪min-rank 병합 (넓은 recall)",
}

# WF 진단용 크기 후보(리프트 보고만). 실제 방출 그물은 항상 DEFAULT_EXPAND_SIZE(24).
# v5가 WF selected_size(30/36)를 방출해 ③이 '확장 30'으로 흔들리던 회귀를 되돌린다.
EXPAND_SIZE_CANDIDATES = (18, 24, 30)
DEFAULT_EXPAND_SIZE = 24
# 방출 고정 24. WF 후보는 진단만(30까지) — 방출에 selected_size 쓰지 않음.
WF_MAX_EXPAND_SIZE = 30
DEFAULT_EXPAND_MODE = "single_raw"
# v6: 방출 top24 고정 + 다중엔진 순위(LOO신호·1:1곱·min-rank·구간 강수/기대)
# — 그물 키우지 않고 엔진 합의로 중하위 당첨(1235:7)을 top24에 올린다.
COVERAGE_BUILD_ID = "expand24-v6-multi"


def _merge_expand_order(
    ranked: List[int],
    boe_order: List[int],
    core: List[int],
    *,
    size: int = 18,
) -> List[int]:
    """core → min-rank → 단일신호 순으로 합쳐 recall 후보풀을 만든다(중복 제거)."""
    order: List[int] = []
    seen: set = set()
    for n in list(core) + list(boe_order) + list(ranked):
        if n in seen:
            continue
        order.append(n)
        seen.add(n)
        if len(order) >= max(size * 2, 30):
            break
    return order


def _decade_tier_sets(sigs: Dict[str, Dict[int, float]]) -> tuple[set, set]:
    """프론트 ★1:1 강수·기대(구간별 상위3+다음3)와 동일 계층 — 당첨 미사용."""
    tb = sigs.get("total_freq") or {}
    pair = sigs.get("pair_product") or {}
    strong: set = set()
    expected: set = set()
    for lo, hi in ((1, 9), (10, 19), (20, 29), (30, 39), (40, 45)):
        in_band = [
            n for n in range(lo, hi + 1)
            if float(tb.get(n, 0)) > 0
        ]
        in_band.sort(
            key=lambda n: (
                -float(tb.get(n, 0)),
                -float(pair.get(n, 0)),
                n,
            )
        )
        strong.update(in_band[:3])
        expected.update(in_band[3:6])
    return strong, expected


def _multi_engine_order(
    sigs: Dict[str, Dict[int, float]],
    signal_key: str,
    *,
    exclude_keys: List[str] | None = None,
) -> tuple[List[int], Dict[str, Any]]:
    """번호추천 확장망용 다중엔진 순위 — 그물 크기↑ 대신 엔진 합의↑.

    축: LOO/주신호 순위 · 1:1 pair_product · 전엔진 min-rank · 구간 강수/기대.
    당첨번호 미사용(누수 없음).
    """
    tb = sigs.get("total_freq") or {}
    af = sigs.get("auto_freq") or {}
    primary = _rank_signal(
        sigs.get(signal_key, sigs.get("support", {})),
        tb,
        af,
    )
    pair = _rank_signal(sigs.get("pair_product", sigs.get("support", {})), tb, af)
    boe = _best_of_engines_order(sigs, exclude_keys=exclude_keys)
    strong, expected = _decade_tier_sets(sigs)
    pri_pos = {n: i for i, n in enumerate(primary)}
    pair_pos = {n: i for i, n in enumerate(pair)}
    boe_pos = {n: i for i, n in enumerate(boe)}

    def score(n: int) -> float:
        # 순위 앞쪽일수록 가산. 구간 강수/기대는 프론트에서 당첨을 잘 담던 축.
        s = 0.0
        s += max(0, 45 - pri_pos.get(n, 45)) * 3.0
        s += max(0, 45 - pair_pos.get(n, 45)) * 2.5
        s += max(0, 45 - boe_pos.get(n, 45)) * 2.0
        if n in strong:
            s += 28.0
        elif n in expected:
            s += 20.0
        s += float(tb.get(n, 0)) * 0.05
        return s

    order = sorted(range(1, 46), key=lambda n: (-score(n), n))
    meta = {
        "engines": ["primary", "pair_product", "min_rank", "decade_strong", "decade_expected"],
        "decade_strong": sorted(strong),
        "decade_expected": sorted(expected),
        "primary_signal": signal_key,
    }
    return order, meta


def _expand_from_mode(
    ranked: List[int],
    boe_order: List[int],
    core: List[int],
    present: set,
    mode: str,
    *,
    size: int = DEFAULT_EXPAND_SIZE,
) -> List[int]:
    """expand 넓은 그물 구성 모드 — walk-forward 가 고른 (mode, size) 를 그대로 재현."""
    size = max(6, min(WF_MAX_EXPAND_SIZE, int(size)))
    if mode == "single_raw":
        return ranked[:size]
    if mode == "single_balanced":
        return _balance_expand(ranked, core, present, size)
    if mode == "boe_raw":
        out: List[int] = list(core)
        seen = set(out)
        for n in boe_order:
            if n in seen:
                continue
            out.append(n)
            seen.add(n)
            if len(out) >= size:
                break
        return out[:size]
    if mode == "merge_raw":
        return _merge_expand_order(ranked, boe_order, core, size=size)[:size]
    if mode == "merge_balanced":
        merged = _merge_expand_order(ranked, boe_order, core, size=size)
        return _balance_expand(merged, core, present, size)
    # default / boe_balanced
    return _balance_expand(boe_order, core, present, size)


def _ensure_core_subset(expand: List[int], core: List[int], size: int) -> List[int]:
    if set(core).issubset(set(expand)):
        return expand[:size]
    merged = list(core)
    seen = set(merged)
    for n in expand:
        if n not in seen:
            merged.append(n)
            seen.add(n)
        if len(merged) >= size:
            break
    return merged[:size]


def _loo_best_signal_key(
    samples,
    held_i: int,
    *,
    pos_by_round: List[Dict[str, Dict[int, int]]] | None = None,
) -> str:
    """held 회차를 빼고 다회차 top18 성적으로 신호를 고른다(누수 없음)."""
    keys = list(_SIGNAL_LABELS.keys())
    rounds = len(samples)
    random_top18 = 18 * 6 / 45
    if pos_by_round is None:
        pos_by_round = []
        for s in samples:
            sigs = _signals(s.auto_lines, s.semi_lines)
            per_sig: Dict[str, Dict[int, int]] = {}
            for sk in keys:
                ranked = _rank_signal(sigs[sk], sigs["total_freq"], sigs.get("auto_freq"))
                rank_of = {num: idx + 1 for idx, num in enumerate(ranked)}
                per_sig[sk] = {num: rank_of[num] for num in s.winning}
            pos_by_round.append(per_sig)
    best_sk, best_score = None, -1
    for sk in keys:
        if sk == "auto_freq":
            continue
        tot = sum(
            sum(1 for r in pos_by_round[j][sk].values() if r <= 18)
            for j in range(rounds)
            if j != held_i
        )
        held_n = rounds - 1
        mean18 = tot / held_n if held_n else 0
        if mean18 <= random_top18:
            continue
        if tot > best_score:
            best_score, best_sk = tot, sk
    if best_sk is None:
        for sk in [k for k in keys if k != "auto_freq"] or keys:
            tot = sum(
                sum(1 for r in pos_by_round[j][sk].values() if r <= 18)
                for j in range(rounds)
                if j != held_i
            )
            if tot > best_score:
                best_score, best_sk = tot, sk
    return best_sk or "support"


def _walkforward_expand_policy(
    samples,
    *,
    exclude_keys: List[str] | None = None,
) -> Dict[str, Any]:
    """보관 회차 LOO 로 expand (mode × size) 를 고른다.

    각 held-out 회차: 나머지 회차로 신호 선택 → held 용지에 모드·크기별 적중 비교.
    평균 적중 최대를 채택. 동점이면 더 큰 size(가까운 미포착대 보존) →
    single_balanced → merge → boe → single_raw 순.
    표본 부족(<2)이면 기본 single_raw@24 (1234 실측: top18이 23–24위 당첨을 자르던 실패 보정).
    """
    modes = list(EXPAND_MODE_LABELS.keys())
    sizes = list(EXPAND_SIZE_CANDIDATES)
    # 동점 시: 큰 그물 우선(recall) · 균형 우선 · raw 단일은 최후
    prefer_tie = [
        (m, s)
        for s in sorted(sizes, reverse=True)
        for m in (
            "single_balanced",
            "merge_balanced",
            "merge_raw",
            "boe_balanced",
            "boe_raw",
            "single_raw",
        )
        if m in modes
    ]
    rounds = len(samples)
    if rounds < 2:
        return {
            "ok": False,
            "selected_mode": DEFAULT_EXPAND_MODE,
            "selected_size": DEFAULT_EXPAND_SIZE,
            "selected_label": (
                f"{EXPAND_MODE_LABELS[DEFAULT_EXPAND_MODE]} · top{DEFAULT_EXPAND_SIZE}"
            ),
            "rounds": rounds,
            "random_baseline": round(DEFAULT_EXPAND_SIZE * 6 / 45, 3),
            "means": {},
            "means_by_size": {},
            "per_round": [],
            "beats_random": False,
            "beats_legacy_boe_balanced": False,
            "reason": f"표본 2회차 미만 — 기본 {DEFAULT_EXPAND_MODE}@{DEFAULT_EXPAND_SIZE}",
        }

    keys = list(_SIGNAL_LABELS.keys())
    pos_by_round: List[Dict[str, Dict[int, int]]] = []
    for s in samples:
        sigs = _signals(s.auto_lines, s.semi_lines)
        per_sig: Dict[str, Dict[int, int]] = {}
        for sk in keys:
            ranked = _rank_signal(sigs[sk], sigs["total_freq"], sigs.get("auto_freq"))
            rank_of = {num: idx + 1 for idx, num in enumerate(ranked)}
            per_sig[sk] = {num: rank_of[num] for num in s.winning}
        pos_by_round.append(per_sig)

    combos = [(m, s) for m in modes for s in sizes]
    hit_sums = {f"{m}@{s}": 0 for m, s in combos}
    per_round: List[Dict[str, Any]] = []
    for i, s in enumerate(samples):
        sk = _loo_best_signal_key(samples, i, pos_by_round=pos_by_round)
        sigs = _signals(s.auto_lines, s.semi_lines)
        ranked = _rank_signal(sigs.get(sk, sigs["support"]), sigs["total_freq"], sigs.get("auto_freq"))
        core = ranked[:6]
        present = {n for n in range(1, 46) if sigs["total_freq"].get(n, 0) > 0}
        boe = _best_of_engines_order(sigs, exclude_keys=exclude_keys)
        win = set(s.winning)
        row_hits: Dict[str, int] = {}
        for m, sz in combos:
            expand = _expand_from_mode(ranked, boe, core, present, m, size=sz)
            key = f"{m}@{sz}"
            row_hits[key] = len(win & set(expand))
            hit_sums[key] += row_hits[key]
        per_round.append({
            "held_round": s.round_no,
            "chosen_signal": sk,
            "hits": row_hits,
        })

    means = {k: round(hit_sums[k] / rounds, 3) for k in hit_sums}
    means_by_size = {
        str(sz): round(
            max(hit_sums[f"{m}@{sz}"] for m in modes) / rounds,
            3,
        )
        for sz in sizes
    }
    best_mean = max(means.values()) if means else 0.0
    tied = [pair for pair in prefer_tie if means.get(f"{pair[0]}@{pair[1]}") == best_mean]
    selected_mode, selected_size = tied[0] if tied else (DEFAULT_EXPAND_MODE, DEFAULT_EXPAND_SIZE)
    legacy_key = "boe_balanced@24"
    legacy = means.get(legacy_key, means.get("boe_balanced@36", 0.0))
    selected_key = f"{selected_mode}@{selected_size}"
    random_base = round(selected_size * 6 / 45, 3)
    lift_30 = means_by_size.get("30", 0) - means_by_size.get("24", 0)
    lift_24_18 = means_by_size.get("24", 0) - means_by_size.get("18", 0)
    return {
        "ok": True,
        "selected_mode": selected_mode,
        "selected_size": selected_size,
        "selected_label": (
            f"{EXPAND_MODE_LABELS.get(selected_mode, selected_mode)} · top{selected_size}"
        ),
        "rounds": rounds,
        "random_baseline": random_base,
        "means": means,
        "means_by_size": means_by_size,
        "size_lift_30_vs_24": round(lift_30, 3),
        "size_lift_24_vs_18": round(lift_24_18, 3),
        "per_round": per_round,
        "beats_random": best_mean > random_base,
        "beats_legacy_boe_balanced": means.get(selected_key, 0) > legacy + 1e-9,
        "legacy_boe_balanced_mean": legacy,
        "selected_mean": means.get(selected_key),
    }


def _coverage_hit_audit(
    sigs: Dict[str, Dict[int, float]],
    cov: Dict[str, Any],
    winning: List[int],
    *,
    exclude_keys: List[str] | None = None,
) -> Dict[str, Any]:
    """이 회차 추천 vs 당첨 — 티켓 천장·확장망 밖 당첨·신호 순위 감사."""
    win = [int(n) for n in winning if 1 <= int(n) <= 45]
    win_set = set(win)
    present = {n for n in range(1, 46) if sigs.get("total_freq", {}).get(n, 0) > 0}
    on_ticket = sorted(win_set & present)
    missing_ticket = sorted(win_set - present)
    core = set(cov.get("core6") or [])
    expand = set(cov.get("expand18") or [])
    ban = list(exclude_keys or [])
    boe = _best_of_engines_order(sigs, exclude_keys=ban)
    boe_rank = {n: i + 1 for i, n in enumerate(boe)}
    sk = cov.get("signal") or "support"
    ranked = _rank_signal(sigs.get(sk, sigs["support"]), sigs.get("total_freq"), sigs.get("auto_freq"))
    single_rank = {n: i + 1 for i, n in enumerate(ranked)}
    outside = sorted(set(on_ticket) - expand)
    outside_detail = [
        {
            "number": n,
            "single_rank": single_rank.get(n),
            "boe_rank": boe_rank.get(n),
            "in_raw_expand": n in set(cov.get("expand18_raw") or []),
            "in_single_expand": n in set(cov.get("expand18_single") or []),
        }
        for n in outside
    ]
    random6 = round(6 * 6 / 45, 3)
    expand_n = max(1, len(expand))
    random_expand = round(expand_n * 6 / 45, 3)
    top18_hit = len(win_set & set(cov.get("expand18_precision") or cov.get("expand18_raw") or []))
    return {
        "winning": win,
        # 하위호환 필드명 유지(프론트 구버전). UI 라벨에는 쓰지 말 것.
        "catchable": on_ticket,
        "uncatchable": missing_ticket,
        "catchable_count": len(on_ticket),
        "on_ticket": on_ticket,
        "missing_ticket": missing_ticket,
        "on_ticket_count": len(on_ticket),
        "core6_hit": sorted(core & win_set),
        "expand18_hit": sorted(expand & win_set),
        "core6_count": len(core & win_set),
        "expand18_count": len(expand & win_set),
        "expand_size": expand_n,
        "expand18_precision_count": top18_hit,
        "outside_expand": outside,
        "missed_catchable": outside,  # 하위호환
        "missed_detail": outside_detail,
        "random_expect_core6": random6,
        "random_expect_expand18": random_expand,
        "vs_random_expand": round(len(expand & win_set) - random_expand, 3),
        "ceiling_note": (
            f"티켓에 없는 당첨 {len(missing_ticket)}개 = 구조적 천장"
            if missing_ticket
            else "당첨 6개 모두 용지에 존재(천장=엔진 순위)"
        ),
    }


def _decade_catch(samples=None) -> Dict[str, Any]:
    """복기 보관 회차에서 '구간별 당첨번호를 최선 신호(양쪽 지지) 상위18이 얼마나
    잡았나' 를 집계 — 어느 구간이 커버리지에서 덜 잡혔는지 정직하게 보여준다.
    ⚠️ 로또는 i.i.d. — 구간별 당첨 '확률' 은 동일하다. 표본(회차) 이 적어 구간별 편차는
    대개 우연이다. 이 진단의 목적은 확률 비교가 아니라, 넓은 그물이 어느 구간을 구조적으로
    빠뜨렸는지 찾아 커버리지를 보정하는 것이다. 과거(추첨완료) 회차만 사용(누수 없음)."""
    from .feature_learning_engine import collect_round_samples

    if samples is None:
        samples = collect_round_samples()
    per_decade = {d: {"winning": 0, "caught_top18": 0} for d in range(5)}
    rounds = 0
    for s in samples:
        sigs = _signals(s.auto_lines, s.semi_lines)
        pos = {n: i + 1 for i, n in enumerate(
            _rank_signal(sigs["support"], sigs["total_freq"], sigs.get("auto_freq"))
        )}
        for w in s.winning:
            d = _decade(w)
            per_decade[d]["winning"] += 1
            if pos.get(w, 99) <= 18:
                per_decade[d]["caught_top18"] += 1
        rounds += 1
    out = []
    for d in range(5):
        win = per_decade[d]["winning"]
        caught = per_decade[d]["caught_top18"]
        out.append({
            "decade": DECADE_LABELS[d],
            "winning": win,
            "caught_top18": caught,
            "catch_rate": round(caught / win, 3) if win else None,
        })
    # 가장 덜 잡힌 구간(당첨은 있었는데 커버리지가 낮음) — '보완 대상' 후보.
    weak = [r["decade"] for r in out if r["winning"] > 0 and (r["catch_rate"] or 0) < 0.5]
    return {"rounds": rounds, "per_decade": out, "weak_decades": weak}


def _line_freq(lines: List[List[int]]) -> Counter:
    c: Counter = Counter()
    for ln in lines:
        for n in {int(x) for x in ln if 1 <= int(x) <= 45}:
            c[n] += 1
    return c


def _signals(auto: List[List[int]], semi: List[List[int]]) -> Dict[str, Dict[int, float]]:
    import math

    from .feature_learning_engine import _detect_fixed_semi

    ac = _line_freq(auto)
    sc = _line_freq(semi)
    # 반자동 고정수(사용자 지정 반복)는 반자동 지지·전체빈도에서 제외 — feature/pattern/
    # carryover 와 동일 기준으로 '지지/강수' 신호를 일관되게 정화(과거엔 이 모듈만 미제외라
    # 같은 support 신호가 섹션마다 값이 달랐다).
    fixed = _detect_fixed_semi(semi)
    sc_sup = {n: (0.0 if n in fixed else float(sc.get(n, 0))) for n in range(1, 46)}
    support = {n: float(min(float(ac.get(n, 0)), sc_sup[n])) for n in range(1, 46)}
    total = {n: float(ac.get(n, 0) + sc_sup[n]) for n in range(1, 46)}
    # 로컬 히어로(predictedNumbers) 1:1 핵심식과 패리티 —
    # log2(auto+1)*log2(semi+1). 한쪽만 인기인 번호는 반대쪽 log≈0 으로 억제.
    # (프론트 매치보너스·세트·평행은 보조항 — 서버는 핵심 곱만 엔진 신호로 편입)
    pair_product = {
        n: math.log2(float(ac.get(n, 0)) + 1.0) * math.log2(sc_sup[n] + 1.0) * 4.0
        for n in range(1, 46)
    }
    # 균형: 지지 점수에 구간(10단위) 상한을 둬 한 구간 쏠림을 억제한 커버리지 지향 신호.
    balanced_order = _rank_signal(support, total, {n: float(ac.get(n, 0)) for n in range(1, 46)})
    balanced_val: Dict[int, float] = {}
    dc: Counter = Counter()
    score = 45.0
    for n in balanced_order:
        d = min(4, (n - 1) // 10)
        pen = 0.5 if dc[d] >= 2 else 1.0  # 같은 구간 3번째부터 감점
        balanced_val[n] = score * pen
        dc[d] += 1
        score -= 1
    # 사용자 가설 신호: 번호가 '반복 등장(line_count) × 우연 초과 묶임(lift)' 조합에
    # 든 정도. 자동 줄 기준(용지 겹침 분석의 표시 기준과 동일).
    from .overlap_learning import combo_strength_by_number

    combo_strength = combo_strength_by_number(auto, "rv")
    # 반자동 전용 빈도(고정수 제외) — 사용자 관찰('반자동에 자주 나온 번호')을
    # 다회차 상위K 커버리지로 정직하게 검증. 자동 빈도와 대칭이되, 고정수 왜곡은 제거.
    semi_freq = dict(sc_sup)

    return {
        "support": support,
        "auto_freq": {n: float(ac.get(n, 0)) for n in range(1, 46)},
        "semi_freq": semi_freq,
        "total_freq": total,
        "pair_product": pair_product,
        "balanced": balanced_val,
        "combo_strength": combo_strength,
    }


_SIGNAL_LABELS = {
    "support": "양쪽 지지(자동∩반자동)",
    "auto_freq": "자동 빈도",
    "semi_freq": "반자동 빈도(고정수 제외)",
    "total_freq": "전체 빈도(자동+반자동)",
    "pair_product": "1:1 곱(자동×반자동 log)",
    "balanced": "구간 균형 커버리지",
    "combo_strength": "조합 강도(반복줄×lift)",
}


def _review_signal_key_for_round(
    samples,
    review_round: int,
    multi_key: str | None,
) -> tuple[str, str]:
    """복기 커버리지용 신호 — 이 회차를 뺀 LOO(누수 없음).

    다회차 multi(전체 포함)는 이 용지 위상과 어긋나면 로컬 1:1보다 못하는 회귀를 만든다.
    이번회차 forward 주입은 multi 를 그대로 쓴다.
    """
    if samples and len(samples) >= 2:
        for i, s in enumerate(samples):
            if int(s.round_no) == int(review_round):
                return _loo_best_signal_key(samples, i), "loo_held"
    return (multi_key or "support"), ("multi_round" if multi_key else "support_default")


def _review_expand_mode(wf_mode: str | None) -> str:
    """복기 넓은 그물: 단일신호 topK 는 신호키가 이 용지와 어긋나면 catchable 을 자름.

    로컬 히어로(1:1 top24)가 더 잘 잡히던 관측(1234·1235) 보정 —
    복기 expand 는 단일∪min-rank 병합(merge_raw)으로 포착 상한을 확보한다.
    이번회차 forward 는 WF 선택 모드를 유지.
    """
    mode = wf_mode or DEFAULT_EXPAND_MODE
    if mode.startswith("single_"):
        return "merge_raw"
    return mode if mode in EXPAND_MODE_LABELS else DEFAULT_EXPAND_MODE


def _build_semi_signal_report(
    *,
    leaderboard: Dict[str, Any],
    current_sigs: Dict[str, Dict[int, float]],
    current_semi: List[List[int]],
    current_fixed: List[int],
) -> Dict[str, Any]:
    """반자동 빈도 신호의 다회차 검증 요약 + 이번회차 상위 번호.

    확률을 올리지 않는다. 복기 보관 회차에서 top18 커버리지가 무작위(≈2.4)를
    넘는지·소표본인지 정직히 고지하고, 이번회차 반자동 시트 상위만 보여준다.
    """
    lb_rows = list(leaderboard.get("leaderboard") or [])
    entry = next((e for e in lb_rows if e.get("key") == "semi_freq"), None)
    rounds = int(leaderboard.get("rounds") or 0)
    small = bool(leaderboard.get("small_sample"))
    random18 = float((leaderboard.get("random_baseline") or {}).get("top18") or (18 * 6 / 45))
    if entry is None:
        return {
            "ok": False,
            "reason": "반자동 빈도 신호 집계 없음(복기 표본 부족)",
            "rounds": rounds,
            "small_sample": small,
        }
    mean18 = float(entry.get("mean_top18") or 0)
    mean6 = float(entry.get("mean_top6") or 0)
    beats = bool(entry.get("beats_random18"))
    under = bool(entry.get("underperforming"))
    sig = entry.get("significance") or {}
    if rounds < 2:
        verdict = "표본 부족 — 참고만"
    elif small and beats:
        verdict = "소표본 · 우연 가능 — 참고만"
    elif beats and not under:
        verdict = "복기 검증 통과(상위18 > 무작위) — 참고 표시"
    else:
        verdict = "평탄(무작위와 구분 안 됨) — 추천 가중 없음"

    top12: List[int] = []
    top18: List[int] = []
    if current_sigs.get("semi_freq") and current_semi:
        ranked = _rank_signal(
            current_sigs["semi_freq"],
            current_sigs.get("total_freq"),
            current_sigs.get("auto_freq"),
        )
        # 빈도 0(고정수·미등장)은 제외
        present = [n for n in ranked if float(current_sigs["semi_freq"].get(n, 0)) > 0]
        top12 = present[:12]
        top18 = present[:18]

    return {
        "ok": True,
        "key": "semi_freq",
        "label": _SIGNAL_LABELS["semi_freq"],
        "rounds": rounds,
        "small_sample": small,
        "mean_top6": mean6,
        "mean_top18": mean18,
        "random_top18": round(random18, 3),
        "beats_random18": beats,
        "underperforming": under,
        "significance": sig,
        "verdict": verdict,
        "show_in_recommend": bool(beats and not under and rounds >= 2 and top12),
        "current_top12": top12,
        "current_top18": top18,
        "current_fixed_excluded": list(current_fixed),
        "current_semi_line_count": len(current_semi),
        "honesty": (
            "1등 확률(1/8,145,060)은 불변. 반자동 등장 상위는 복기 커버리지 검증 참고이며 "
            "핵심6·용지 5세트를 대체하지 않습니다. 고정수는 제외합니다."
        ),
    }


def _analyze(auto: List[List[int]], semi: List[List[int]], winning: List[int]) -> Dict[str, Any]:
    win_set = set(winning)
    sigs = _signals(auto, semi)
    out_signals: List[Dict[str, Any]] = []
    best = None
    for key, vals in sigs.items():
        ranked = _rank_signal(vals, sigs["total_freq"], sigs.get("auto_freq"))
        pos = {n: ranked.index(n) + 1 for n in range(1, 46)}
        winner_ranks = sorted(
            ({"number": n, "rank": pos[n]} for n in winning),
            key=lambda x: x["rank"],
        )
        coverage = {f"top{k}": sum(1 for n in winning if pos[n] <= k) for k in COVERAGE_KS}
        # 가장 적은 K 로 가장 많은 당첨을 잡는 신호를 best 로.
        catch6 = coverage["top6"]
        catch18 = coverage["top18"]
        entry = {
            "key": key,
            "label": _SIGNAL_LABELS.get(key, key),
            "winner_ranks": winner_ranks,
            "coverage": coverage,
            "top6_numbers": ranked[:6],
        }
        out_signals.append(entry)
        score = (catch6, catch18)
        if best is None or score > best[0]:
            best = (score, entry)
    return {"signals": out_signals, "best_signal_key": best[1]["key"] if best else None}


def _multi_round_backtest(samples=None) -> Dict[str, Any]:
    """보관된 **모든** 회차의 자동·반자동 용지로 '지지(support, 고정수 제외) 상위 K 가
    그 회차 당첨을 얼마나 담나' 를 회차별·평균으로 백테스트한다(단일 회차가 아닌 다회차).

    support_rank 는 build_number_features 가 이미 고정수를 제외해 산출한 값을 재사용 —
    review-verification 단일회차 신호와 동일 기준. 다음 회차 이월(강수 미당첨→다음 당첨)도 병기.
    samples 를 넘기면 재수집하지 않는다(collect_round_samples 는 회차별 feature 재계산이라 무겁다).
    """
    from .feature_learning_engine import collect_round_samples, _detect_fixed_semi

    if samples is None:
        samples = collect_round_samples()
    ks = [6, 12, 18]
    per_round: List[Dict[str, Any]] = []
    agg = {k: {"hit": 0, "exp": 0.0} for k in ks}
    for i, s in enumerate(samples):
        ranked = sorted(range(1, 46), key=lambda n: s.features[n]["support_rank"])
        win = set(s.winning)
        # 반자동 최다반복 번호(고정수 후보) — 임계 미만이라도 분포를 투명하게 보여준다.
        semi_n = max(1, len(s.semi_lines))
        semi_c = _line_freq(s.semi_lines)
        semi_repeat_top = [
            {"number": int(num), "frac": round(cnt / semi_n, 3)}
            for num, cnt in sorted(semi_c.items(), key=lambda kv: (-kv[1], kv[0]))[:6]
        ]
        cov: Dict[str, int] = {}
        for k in ks:
            hit = sum(1 for n in ranked[:k] if n in win)
            cov[str(k)] = hit
            agg[k]["hit"] += hit
            agg[k]["exp"] += k * (6.0 / 45.0)
        carry = None
        if i + 1 < len(samples):
            nxt_win = set(samples[i + 1].winning)
            missed = [n for n in ranked if n not in win][:12]
            carry = {
                "to_round": samples[i + 1].round_no,
                "hit": sum(1 for n in missed if n in nxt_win),
                "pool": len(missed),
                "carried": sorted(n for n in missed if n in nxt_win),
            }
        per_round.append({
            "round_no": s.round_no,
            "winning": list(s.winning),
            "auto_lines": len(s.auto_lines),
            "semi_lines": len(s.semi_lines),
            "fixed_semi": sorted(_detect_fixed_semi(s.semi_lines)),
            "semi_repeat_top": semi_repeat_top,
            "support_coverage": cov,
            "carryover": carry,
        })
    n = max(1, len(samples))
    aggregate = {
        str(k): {
            "mean_hit": round(agg[k]["hit"] / n, 3),
            "mean_exp": round(agg[k]["exp"] / n, 3),
            "lift": round(agg[k]["hit"] / agg[k]["exp"], 3) if agg[k]["exp"] > 0 else 0.0,
            # 유의성 — 이 커버리지가 우연(균등무작위)을 통계적으로 초과하나(소표본 보수).
            "significance": _coverage_significance(agg[k]["hit"], len(samples), k),
        }
        for k in ks
    }
    return {
        "rounds": len(samples),
        "small_sample": len(samples) < SMALL_SAMPLE_ROUNDS,
        "per_round": per_round,
        "aggregate": aggregate,
    }


def _signal_leaderboard(samples=None) -> Dict[str, Any]:
    """복기 보관 **모든** 회차에서 각 신호(고정수 제외)가 그 회차 당첨을 얼마나 담았나를
    집계해 '어느 신호가 당첨을 가장 잘 잡았나' 순위를 낸다.

    이번회차 커버리지 신호를 단일 회차가 아닌 **다회차 성적**으로 고른다 — 단일회차 best
    는 우연에 쉽게 흔들려(같은 support 신호가 회차마다 1등/꼴찌 오갈 수 있음) 신호 선택
    자체가 노이즈였다. 당첨 순위 tier 분포(상위6/7~18/19~30/31~45)도 함께 내 '집중 실패·
    커버리지 유효' 를 정량화한다. 과거(추첨완료) 회차만 사용 — 이번회차 누수 없음.
    """
    from .feature_learning_engine import collect_round_samples

    if samples is None:
        samples = collect_round_samples()
    keys = list(_SIGNAL_LABELS.keys())
    # (회차, 신호) → 당첨번호별 순위 — 회차당 _signals 1회만(combo_strength 재계산이 무겁다)
    # 계산해 agg·유의성·LOO 에서 재사용.
    pos_by_round: List[Dict[str, Dict[int, int]]] = []
    for s in samples:
        sigs = _signals(s.auto_lines, s.semi_lines)
        per_sig: Dict[str, Dict[int, int]] = {}
        for sk in keys:
            ranked = _rank_signal(sigs[sk], sigs["total_freq"], sigs.get("auto_freq"))
            rank_of = {num: idx + 1 for idx, num in enumerate(ranked)}
            per_sig[sk] = {num: rank_of[num] for num in s.winning}
        pos_by_round.append(per_sig)

    agg = {sk: {6: 0, 18: 0} for sk in keys}
    tiers = {sk: {"t6": 0, "t18": 0, "t30": 0, "out": 0} for sk in keys}
    for i, s in enumerate(samples):
        for sk in keys:
            for num in s.winning:
                r = pos_by_round[i][sk][num]
                if r <= 6:
                    agg[sk][6] += 1
                    agg[sk][18] += 1
                    tiers[sk]["t6"] += 1
                elif r <= 18:
                    agg[sk][18] += 1
                    tiers[sk]["t18"] += 1
                elif r <= 30:
                    tiers[sk]["t30"] += 1
                else:
                    tiers[sk]["out"] += 1
    rounds = len(samples)
    n = max(1, rounds)
    random_top6 = round(6 * 6 / 45, 3)   # ≈ 0.8
    random_top18 = round(18 * 6 / 45, 3)  # ≈ 2.4
    leaderboard = sorted(
        (
            {
                "key": sk,
                "label": _SIGNAL_LABELS.get(sk, sk),
                "mean_top6": round(agg[sk][6] / n, 3),
                "mean_top18": round(agg[sk][18] / n, 3),
                "tiers": tiers[sk],
                # 이 신호의 상위18 커버리지가 우연을 유의하게 초과하나(소표본 보수).
                "significance": _coverage_significance(agg[sk][18], rounds, 18),
                # 무작위 이하 = 단독 커버리지 신호로 쓰지 말 것(역산 진단용).
                "underperforming": round(agg[sk][18] / n, 3) <= random_top18,
                "beats_random18": round(agg[sk][18] / n, 3) > random_top18,
            }
            for sk in keys
        ),
        key=lambda x: (-x["mean_top18"], -x["mean_top6"], x["key"]),
    )
    # 단독 best 는 무작위 초과 신호만. 전부 이하면 성적 1위 폴백(빈 신호 금지).
    # auto_freq 는 구조적으로 최악인 경우가 많아, 초과해도 다른 초과 신호가 있으면 후순위.
    eligible = [e for e in leaderboard if e["beats_random18"] and e["key"] != "auto_freq"]
    if not eligible:
        eligible = [e for e in leaderboard if e["beats_random18"]]
    if not eligible:
        eligible = list(leaderboard)
    # Leave-one-out 교차검증 — 각 회차를 빼고 나머지로 최고 신호를 고른 뒤, 뺀 회차에서의
    # 상위18 적중. '신호 선택'이 과적합이 아니라 실제로 일반화되는지 정직하게 본다(누수 없음:
    # 뺀 회차는 선택에 미참여). 소표본이면 표본이 더 흔들려 참고용.
    # 단독 선택과 동일 정책: 무작위 초과 우선, auto_freq 후순위.
    loo: List[Dict[str, Any]] = []
    if rounds >= 3:
        for i in range(rounds):
            best_sk, best_score = None, -1
            for sk in keys:
                if sk == "auto_freq":
                    continue
                tot = sum(
                    sum(1 for r in pos_by_round[j][sk].values() if r <= 18)
                    for j in range(rounds) if j != i
                )
                held_n = rounds - 1
                mean18 = tot / held_n if held_n else 0
                # 무작위 이하 신호는 LOO 선택에서도 제외(전부 이하면 아래에서 폴백).
                if mean18 <= random_top18:
                    continue
                if tot > best_score:
                    best_score, best_sk = tot, sk
            if best_sk is None:
                # 폴백 — auto_freq 제외 전 신호, 그래도 없으면 전체.
                for sk in [k for k in keys if k != "auto_freq"] or keys:
                    tot = sum(
                        sum(1 for r in pos_by_round[j][sk].values() if r <= 18)
                        for j in range(rounds) if j != i
                    )
                    if tot > best_score:
                        best_score, best_sk = tot, sk
            held_hit = sum(1 for r in pos_by_round[i][best_sk].values() if r <= 18)
            loo.append({
                "held_round": samples[i].round_no,
                "chosen_signal": best_sk,
                "chosen_label": _SIGNAL_LABELS.get(best_sk, best_sk),
                "top18_hit": held_hit,
            })
    loo_mean = round(sum(x["top18_hit"] for x in loo) / len(loo), 3) if loo else None
    best_entry = eligible[0] if (eligible and samples) else None
    return {
        "rounds": rounds,
        "small_sample": rounds < SMALL_SAMPLE_ROUNDS,
        "leaderboard": leaderboard,
        "best_signal_multi": best_entry["key"] if best_entry else None,
        "random_baseline": {"top6": random_top6, "top18": random_top18},
        "underperforming_keys": [e["key"] for e in leaderboard if e.get("underperforming")],
        "loo": {
            "folds": loo,
            "mean_top18_hit": loo_mean,
            "random_baseline": random_top18,
            "generalizes": bool(loo_mean is not None and loo_mean > random_top18),
        },
    }


def _best_of_engines_order(
    sigs: Dict[str, Dict[int, float]],
    *,
    exclude_keys: List[str] | None = None,
) -> List[int]:
    """전 신호의 '최선(최소) 순위'로 번호를 정렬 — 어느 엔진이든 상위로 꼽은 번호를 앞에
    둔다. 넓은 그물(expand18)의 본령: 합의·평균은 약신호가 최고신호를 희석하고 특정 엔진만
    잡은 catchable 당첨을 놓치지만(예: 조합강도만 잡은 번호), 최선순위는 '어느 엔진이든
    잡았으면 포함'이라 상위K 로 담을 수 있는 당첨을 최대한 담는다. 동률은 총 등장으로 정렬.

    exclude_keys: 저성과·auto_freq 등 banned 신호 — 단독 커버리지뿐 아니라 min-rank 에도
    넣어 약한 신호가 expand18 상위를 오염시키지 않게 한다. 제외 후 신호가 2개 미만이면
    전체 키로 폴백(빈 그물 방지).
    ⚠️ 확률 불변 — 넓은 그물의 recall 을 높일 뿐, 잭팟·부분일치 기대값은 안 변한다."""
    ban = set(exclude_keys or [])
    keys = [k for k in _SIGNAL_LABELS.keys() if k not in ban and k in sigs]
    if len(keys) < 2:
        keys = [k for k in _SIGNAL_LABELS.keys() if k in sigs]
    tb = sigs.get("total_freq", {})
    af = sigs.get("auto_freq", {})
    pos = {sk: {n: i for i, n in enumerate(_rank_signal(sigs[sk], tb, af))} for sk in keys}
    min_rank = {n: min(pos[sk][n] for sk in keys) for n in range(1, 46)}
    return sorted(range(1, 46), key=lambda n: (min_rank[n], -tb.get(n, 0.0), -af.get(n, 0.0), n))


def _coverage_set_from_signals(
    sigs: Dict[str, Dict[int, float]],
    *,
    signal_key: str,
    selected_by: str,
    exclude_keys: List[str] | None = None,
    expand_mode: str | None = None,
    expand_size: int | None = None,
) -> Dict[str, Any]:
    """core6 + expand24 커버리지.

    - core6: 주신호(집중) — 약신호 희석 방지.
    - expand24: 다중엔진 순위 top24 (주신호·1:1곱·min-rank·구간 강수/기대).
      그물 크기를 30/36으로 키우지 않고, UI에 이미 있는 엔진 축을 추천에 끌어온다.
    """
    ranked = _rank_signal(
        sigs.get(signal_key, sigs["support"]),
        sigs.get("total_freq"),
        sigs.get("auto_freq"),
    )
    core = ranked[:6]
    present = {n for n in range(1, 46) if sigs["total_freq"].get(n, 0) > 0}
    precision18 = ranked[:18]
    single_expand = _balance_expand(ranked, core, present, 18)
    boe_order = _best_of_engines_order(sigs, exclude_keys=exclude_keys)
    mode = expand_mode or DEFAULT_EXPAND_MODE
    if mode not in EXPAND_MODE_LABELS:
        mode = DEFAULT_EXPAND_MODE
    # 방출 크기 고정 24 — WF selected_size(30 등)는 진단 전용.
    _ = expand_size
    size = DEFAULT_EXPAND_SIZE
    multi_order, multi_meta = _multi_engine_order(
        sigs, signal_key, exclude_keys=exclude_keys
    )
    # 다중엔진 top24 를 본망으로. merge_raw 등 모드망은 진단·폴백.
    mode_expand = _expand_from_mode(ranked, boe_order, core, present, mode, size=size)
    expand = _ensure_core_subset(multi_order[:size], core, size)
    # present 우선 — 미등장 번호가 합의 점수로 새어 들어오면 용지 등장분으로 교체
    expand_present = [n for n in expand if n in present]
    if len(expand_present) < size:
        for n in multi_order:
            if len(expand_present) >= size:
                break
            if n in present and n not in expand_present:
                expand_present.append(n)
        for n in expand:
            if len(expand_present) >= size:
                break
            if n not in expand_present:
                expand_present.append(n)
    expand = expand_present[:size]
    boe_expand = _balance_expand(boe_order, core, present, size)
    return {
        "signal": signal_key,
        "signal_label": _SIGNAL_LABELS.get(signal_key, signal_key),
        "selected_by": selected_by,
        "core6": core,
        # 하위호환: 필드명 expand18 유지 — 실제 길이는 expand_size(24).
        "expand18": expand,
        "expand_size": size,
        "expand18_mode": "multi_engine",
        "expand18_mode_label": (
            f"다중엔진(주신호+1:1곱+min-rank+구간강수/기대) · top{size}"
        ),
        "expand18_precision": precision18,
        "expand18_single": single_expand,
        "expand18_raw": mode_expand,
        "expand18_boe_balanced": boe_expand,
        "decade_balance": _decade_balance_info(expand, precision18, present),
        "excluded_signals": list(exclude_keys or []),
        "coverage_build": COVERAGE_BUILD_ID,
        "multi_engine": multi_meta,
        "precision_gap_hint": {
            "top24": 24,
            "note": "확장24=다중엔진 합의. 크기를 키우지 않고 구간 강수/기대·1:1곱을 끌어온다.",
        },
    }


def _consensus_coverage(
    cur_signals: Dict[str, Dict[int, float]], leaderboard: Dict[str, Any]
) -> Dict[str, Any]:
    """커버리지를 '검증 통과 신호들의 합의'로 만든다 — 단일 신호가 아니라, 복기서
    당첨을 무작위 이상으로 잡았던 신호들이 **함께** 상위로 가리키는 번호를 위로 올린다.

    good 신호 = 다회차 상위18 평균이 무작위 기대(2.4) 초과. 각 번호가 몇 개 good 신호의
    top-18 에 들었나(agreement)로 정렬 → '여러 신호가 동의할수록 핵심'. 과거 회차 성적만
    사용(누수 없음). 확률 불변 — 넓은 합의 표시용.
    """
    lb = leaderboard.get("leaderboard", []) or []
    random_top18 = 18 * 6 / 45  # ≈ 2.4
    banned = set(leaderboard.get("underperforming_keys") or [])
    # good = 다회차 상위18이 무작위 초과 AND underperforming 아님. auto_freq 는 단독 제외.
    good = [
        e["key"] for e in lb
        if float(e.get("mean_top18", 0)) > random_top18
        and e["key"] not in banned
        and e["key"] != "auto_freq"
        and e["key"] in cur_signals
    ]
    if len(good) < 2:  # 무작위 초과 신호가 부족하면 성적 상위(auto_freq·저성과 제외) 폴백
        good = [
            e["key"] for e in lb
            if e["key"] in cur_signals and e["key"] != "auto_freq" and e["key"] not in banned
        ][:3]
    if len(good) < 2:
        good = [e["key"] for e in lb[:3] if e["key"] in cur_signals]
    if not good:
        return {}
    agree = {n: 0 for n in range(1, 46)}
    best_rank = {n: 99 for n in range(1, 46)}
    total_tb = cur_signals.get("total_freq")
    for key in good:
        ranked = _rank_signal(cur_signals[key], total_tb, cur_signals.get("auto_freq"))
        for i, n in enumerate(ranked):
            if i < 18:
                agree[n] += 1
            best_rank[n] = min(best_rank[n], i + 1)
    order = sorted(range(1, 46), key=lambda n: (-agree[n], best_rank[n], n))
    need = max(2, len(good) // 2 + 1)  # 엄격 과반(예: good 4 → 3) good 신호 동의
    core = [n for n in order if agree[n] >= need][:6]
    if len(core) < 6:
        core = order[:6]
    size = DEFAULT_EXPAND_SIZE
    raw_expand = order[:size]
    # 넓은 그물이 티켓 후보 있는 5개 구간을 모두 커버하도록 보정(core ⊂ expand 유지).
    present = {n for n in range(1, 46) if cur_signals.get("total_freq", {}).get(n, 0) > 0}
    expand = _balance_expand(order, core, present, size)
    return {
        "good_signal_count": len(good),
        "good_signals": good,
        "core6": core,
        "expand18": expand,
        "expand_size": size,
        "agreement": {str(n): agree[n] for n in expand},
        "need": need,
        "decade_balance": _decade_balance_info(expand, raw_expand, present),
    }


def _missed_winner_analysis(samples=None) -> Dict[str, Any]:
    """복기 보관 **모든** 회차에서 '어떤 신호로도 못 잡은 당첨번호'를 집계 — 예측의 정직한
    천장(ceiling).

    각 당첨번호의 '전 신호 최선 순위'(모든 신호 중 최소 rank)로 분류: 어떤 신호든 상위6/
    상위18/상위30에 들었나, 아니면 전부 상위밖(구조적 미포착). 티켓(자동·반자동 줄)에 아예
    없던 당첨(미등장)은 티켓 기반으론 원천적으로 못 잡는다. '어떤 분석으로도 못 잡는 당첨이
    얼마나 되나'를 정량화 — 확률을 못 올린다는 직접 증거이자 예측 한계의 정직한 표시.
    과거(추첨완료) 회차만 사용(누수 없음).
    """
    from .feature_learning_engine import collect_round_samples

    if samples is None:
        samples = collect_round_samples()
    keys = list(_SIGNAL_LABELS.keys())
    per_round: List[Dict[str, Any]] = []
    agg = {"total": 0, "top6_any": 0, "top18_any": 0, "top30_any": 0, "uncatchable": 0, "missing_ticket": 0}
    for s in samples:
        sigs = _signals(s.auto_lines, s.semi_lines)
        rank_pos = {
            k: {
                n: i + 1
                for i, n in enumerate(
                    _rank_signal(sigs[k], sigs["total_freq"], sigs.get("auto_freq"))
                )
            }
            for k in keys
        }
        appeared = {int(n) for ln in (s.auto_lines + s.semi_lines) for n in ln if 1 <= int(n) <= 45}
        missed: List[Dict[str, Any]] = []
        caught: List[int] = []
        for n in s.winning:
            best = min((rank_pos[k].get(n, 99) for k in keys), default=99)
            in_ticket = n in appeared
            agg["total"] += 1
            if not in_ticket:
                agg["missing_ticket"] += 1
            if best <= 6:
                agg["top6_any"] += 1
                agg["top18_any"] += 1
                agg["top30_any"] += 1
                caught.append(int(n))
            elif best <= 18:
                agg["top18_any"] += 1
                agg["top30_any"] += 1
                caught.append(int(n))
            else:
                if best <= 30:
                    agg["top30_any"] += 1
                else:
                    agg["uncatchable"] += 1
                missed.append({"number": int(n), "best_rank": int(best), "in_ticket": in_ticket})
        per_round.append({
            "round_no": s.round_no,
            "winning": list(s.winning),
            "caught_top18": caught,
            "missed": missed,
        })
    return {"rounds": len(samples), "aggregate": agg, "per_round": per_round}


def _inverse_diagnosis(
    *,
    leaderboard: Dict[str, Any],
    multi_round: Dict[str, Any],
    missed: Dict[str, Any],
    summary: Dict[str, Any],
    expand_wf: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """시니어/디렉터 관점 역산 진단 — 왜 엔진 당첨률(특히 top-6)이 낮았는지 문제→정책.

    확률을 올리지 않는다. 백테스트가 보여 준 구조적 실패(집중·저성과 신호·천장)를
    주입/추천 정책으로 바꿔 '넓은 그물'이 실제로 쓰이게 한다.
    """
    random6 = 6 * 6 / 45.0    # ≈ 0.8
    random18 = 18 * 6 / 45.0  # ≈ 2.4
    lb_rows = leaderboard.get("leaderboard") or []
    best = next(
        (e for e in lb_rows if e.get("key") == leaderboard.get("best_signal_multi")),
        lb_rows[0] if lb_rows else None,
    )
    mean6 = float(best["mean_top6"]) if best else float(summary.get("best_top6") or 0)
    mean18 = float(best["mean_top18"]) if best else float(summary.get("best_top18") or 0)
    under = list(leaderboard.get("underperforming_keys") or [])
    m18 = (multi_round.get("aggregate") or {}).get("18") or {}
    m6 = (multi_round.get("aggregate") or {}).get("6") or {}
    miss_agg = missed.get("aggregate") or {}
    total_w = max(1, int(miss_agg.get("total") or 0))
    ticket_miss_pct = round(100.0 * int(miss_agg.get("missing_ticket") or 0) / total_w, 1)
    top6_any_pct = round(100.0 * int(miss_agg.get("top6_any") or 0) / total_w, 1)
    top18_any_pct = round(100.0 * int(miss_agg.get("top18_any") or 0) / total_w, 1)
    loo = leaderboard.get("loo") or {}
    small = bool(leaderboard.get("small_sample") or multi_round.get("small_sample"))
    wf = expand_wf or {}
    expand_mode = str(wf.get("selected_mode") or DEFAULT_EXPAND_MODE)
    # 정책·히어로 라벨은 실제 방출 크기(24). WF selected_size 는 진단용만.
    expand_size = DEFAULT_EXPAND_SIZE
    expand_label = (
        f"{EXPAND_MODE_LABELS.get(expand_mode, expand_mode)} · top{expand_size}"
    )

    problems: List[Dict[str, Any]] = []
    # P1 — top-6 집중 실패 (구조)
    if mean6 <= random6 * 1.25 or float(m6.get("mean_hit") or 0) <= random6 * 1.25:
        problems.append({
            "id": "top6_concentration_fail",
            "severity": "high",
            "title": "top-6 집중 픽 구조적 실패",
            "detail": (
                f"다회차 최선 신호 상위6 평균 {mean6:.2f}/6 (무작위≈{random6:.1f}). "
                "당첨은 중간 지지대에 흩어져 집중 픽이 구조적으로 놓친다."
            ),
        })
    # P2 — 저성과 신호를 단독으로 쓰면 안 됨
    if under:
        labels = [
            next((e["label"] for e in lb_rows if e["key"] == k), k) for k in under
        ]
        problems.append({
            "id": "underperforming_signals",
            "severity": "high",
            "title": "저성과 신호 단독 사용 위험",
            "detail": (
                f"상위18이 무작위({random18:.1f}) 이하인 신호: {', '.join(labels)}. "
                "특히 '자동 빈도'는 많이 산 번호에 편향되어 당첨과 무관하다."
            ),
        })
    # P3 — 커버리지 vs 집중 격차
    if mean18 - mean6 >= 1.0:
        problems.append({
            "id": "coverage_gap",
            "severity": "medium",
            "title": "넓은 그물(top-18)만 유효",
            "detail": (
                f"상위18 평균 {mean18:.2f} vs 상위6 {mean6:.2f} — 격차 {mean18 - mean6:.2f}. "
                "핵심6에 높은 가중을 주면 검증학습이 실패 패턴을 강화한다."
            ),
        })
    # P4 — 예측 천장(티켓 미등장)
    if ticket_miss_pct >= 10:
        problems.append({
            "id": "ticket_ceiling",
            "severity": "medium",
            "title": "티켓 미등장 = 구조적 천장",
            "detail": (
                f"당첨의 {ticket_miss_pct}%가 자동·반자동 줄에 아예 없음 — 티켓 기반 엔진으로는 "
                f"원천 미포착. 전신호 상위6 안 {top6_any_pct}% · 상위18 안 {top18_any_pct}%."
            ),
        })
    # P5 — 소표본 / LOO 일반화 약함
    if small or not loo.get("generalizes", True):
        problems.append({
            "id": "small_sample_or_weak_loo",
            "severity": "low",
            "title": "소표본·일반화 근거 약함",
            "detail": (
                f"보관 {leaderboard.get('rounds', 0)}회차"
                + (
                    f" · LOO 상위18 평균 {loo.get('mean_top18_hit')} (무작위 {loo.get('random_baseline')})"
                    if loo.get("mean_top18_hit") is not None
                    else ""
                )
                + ". 순위·lift 는 참고용 — 유의성 게이트를 유지한다."
            ),
        })
    # P6 — 구간균형/크기 walk-forward
    if wf.get("ok") and float(wf.get("size_lift_24_vs_18") or 0) >= 0.5:
        problems.append({
            "id": "expand_top18_truncation",
            "severity": "high",
            "title": "top18 절단이 가까운 당첨을 놓침",
            "detail": (
                f"LOO 기준 top24 최고평균 − top18 최고평균 = {wf.get('size_lift_24_vs_18')}/6. "
                "지지 신호 19–24위 대역(예: 1234회 19·35)이 top18에서 잘린다 → 확장망 top24."
            ),
        })
    if wf.get("ok") and wf.get("beats_legacy_boe_balanced"):
        problems.append({
            "id": "expand_mode_upgraded",
            "severity": "low",
            "title": "확장 그물 walk-forward 승격",
            "detail": (
                f"LOO {wf.get('rounds')}회차 기준 '{expand_label}' 평균 "
                f"{wf.get('selected_mean')}/6 > 레거시 min-rank@18 {wf.get('legacy_boe_balanced_mean')}/6."
            ),
        })
    elif wf.get("ok") and not wf.get("beats_random"):
        problems.append({
            "id": "expand_wf_near_random",
            "severity": "medium",
            "title": "확장 그물 walk-forward ≈ 무작위",
            "detail": (
                f"선택된 모드 평균 {wf.get('selected_mean')} (무작위 {wf.get('random_baseline')}). "
                "넓은 그물도 우연 수준 — 과신 금지, 티켓 천장·소표본을 함께 본다."
            ),
        })

    # 주입/추천 정책 — 프론트·히어로가 그대로 따른다.
    # 앙상블 백테스트 실증: 다중신호 '합의'는 약신호가 최고신호를 희석(합산 top18 < 최고단일).
    # 정립 원칙 — core6=다회차 best 단일신호(정밀) / expand18=WF 선택 모드(recall).
    # prefer_consensus 는 항상 False(하위호환 필드 유지). 합의 세트는 폴백·참고용만.
    expand_first = any(p["id"] in ("top6_concentration_fail", "coverage_gap") for p in problems)
    # core6 가중 하향 / expand18 상향 (기존 0.85/0.45 → 역전)
    core_scale = 0.35 if expand_first else 0.55
    expand_scale = 1.0 if expand_first else 0.7
    # 신뢰도는 다회차 최선 신호의 mean_top18 기준(단일회차 summary 보다 안정).
    multi_conf = max(0.0, min(1.0, (mean18 - random18) / (6.0 - random18))) if mean18 else 0.0
    n_good = len([
        e for e in lb_rows
        if e.get("beats_random18") and e.get("key") != "auto_freq"
    ])
    # API: expand18_mode 는 best_single|best_of_engines|merge_recall (+ WF 세부 variant).
    # 구버전은 single_* 를 best_of_engines 로 잘못 표기해 히어로 정책칩이 거짓이었다.
    expand18_mode_api = (
        "best_of_engines"
        if expand_mode.startswith("boe_")
        else (
            "merge_recall"
            if expand_mode.startswith("merge_")
            else "best_single"
        )
    )

    actions = [
        "저성과·자동빈도 신호를 단독 커버리지에서 제외",
        "핵심6: 다회차 성적 1위 단일신호(합의 희석 금지)",
        f"확장 top{expand_size}: walk-forward '{expand_label}'",
        "주입 가중: expand > core6 (집중 실패 시)" if expand_first else "주입 가중: 균형",
        "티켓 미등장 당첨은 분석 천장으로 고지(확률 불변)",
    ]

    return {
        "problems": problems,
        "actions": actions,
        "verdict": (
            "집중 예측은 구조적으로 실패한다. 핵심6은 최고 단일신호로 정밀하게, "
            f"확장 top{expand_size}는 walk-forward('{expand_label}')로 recall 을 확보한다. "
            "합의·평균은 희석이므로 쓰지 않는다."
            if expand_first
            else (
                f"신호 성적이 무작위와 비슷하다 — 과신 없이 best 단일·"
                f"WF expand({expand_label}) 그물만 유지한다."
            )
        ),
        "metrics": {
            "best_signal": best.get("key") if best else None,
            "best_label": best.get("label") if best else None,
            "mean_top6": round(mean6, 3),
            "mean_top18": round(mean18, 3),
            "random_top6": round(random6, 3),
            "random_top18": round(random18, 3),
            "support_top6_mean": m6.get("mean_hit"),
            "support_top18_mean": m18.get("mean_hit"),
            "ticket_miss_pct": ticket_miss_pct,
            "top6_any_pct": top6_any_pct,
            "top18_any_pct": top18_any_pct,
            "underperforming": under,
            "small_sample": small,
            "loo_generalizes": loo.get("generalizes"),
            "good_signal_count": n_good,
            "expand_wf_mean": wf.get("selected_mean"),
            "expand_wf_mode": expand_mode,
            "expand_wf_size": expand_size,
            "expand_size_lift_24_vs_18": wf.get("size_lift_24_vs_18"),
        },
        "policy": {
            "coverage_mode": "expand18_first" if expand_first else "balanced",
            "core6_weight_scale": core_scale,
            "expand18_weight_scale": expand_scale,
            "multi_round_confidence": round(multi_conf, 3),
            # 하위호환: 합의 희석이 실증됐으므로 항상 False. 프론트는 core6_mode/expand18_mode 우선.
            "prefer_consensus": False,
            "core6_mode": "best_single",
            "expand18_mode": expand18_mode_api,
            "expand18_variant": expand_mode,
            "expand18_variant_label": expand_label,
            "expand_size": expand_size,
            "banned_signals": under + (["auto_freq"] if "auto_freq" not in under else []),
            "preferred_signal": leaderboard.get("best_signal_multi"),
        },
    }


def build_review_verification() -> Dict[str, Any]:
    from .store import (
        _review_entries_for_round,
        _manual_saved_lines,
        _load_current_raw,
    )
    from .draw_template import get_review_round_no, get_current_round_no
    from ..database import load_history

    review_round = int(get_review_round_no())
    df = load_history()
    winning: List[int] = []
    if not df.empty:
        row = df[df["round"].astype(int) == review_round]
        if not row.empty:
            r0 = row.sort_values("round").iloc[-1]
            winning = [int(r0[f"num{i}"]) for i in range(1, 7)]
    if not winning:
        return {"ok": False, "reason": f"{review_round}회 당첨번호가 아직 없습니다.", "round_no": review_round}

    archived, review_saved = _review_entries_for_round(review_round)
    src = archived if archived else review_saved
    src = [{**e, "video_intent": "review"} for e in src]
    auto = _manual_saved_lines(src, "자동", include_photo=True)
    semi = _manual_saved_lines(src, "반자동", include_photo=True)
    if not auto and not semi:
        return {
            "ok": False,
            "reason": f"{review_round}회 복기 용지가 없어 검증할 수 없습니다.",
            "round_no": review_round,
        }

    analysis = _analyze(auto, semi, winning)
    # 보관 샘플은 회차별 feature 재계산이라 무겁다 — 한 번만 수집해 재사용(3× 재수집 방지).
    from .feature_learning_engine import collect_round_samples

    _samples = collect_round_samples()
    leaderboard = _signal_leaderboard(_samples)
    multi_key = leaderboard.get("best_signal_multi")
    # 이번회차 forward: 다회차 best (누수 없음 — 이번회차 미포함 표본).
    bkey = multi_key or "support"
    selected_by = "multi_round" if multi_key else "support_default"
    # 복기 히어로: LOO(이 회차 제외) — multi 가 이 용지와 어긋나 로컬 1:1보다
    # 못하는 회귀(1234·1235)를 막는다. 당첨으로 best를 고르면(analysis.best) 누수.
    review_bkey, review_selected_by = _review_signal_key_for_round(
        _samples, review_round, multi_key
    )
    # min-rank 에서도 저성과·auto_freq 제외 (단독 커버리지와 동일 정책).
    ban_keys = list(leaderboard.get("underperforming_keys") or [])
    if "auto_freq" not in ban_keys:
        ban_keys.append("auto_freq")

    # expand 모드 WF는 진단용. 방출 크기는 항상 24(다중엔진 순위).
    expand_wf = _walkforward_expand_policy(_samples, exclude_keys=ban_keys)
    expand_mode = str(expand_wf.get("selected_mode") or DEFAULT_EXPAND_MODE)
    expand_size = DEFAULT_EXPAND_SIZE
    # 복기 expand 모드 힌트(merge_raw) — 실제 방출은 multi_engine top24.
    review_expand_mode = _review_expand_mode(expand_mode)

    # 복기 회차 커버리지 — 그 회차 용지 + LOO 주신호 core + 다중엔진 expand.
    review_sigs = _signals(auto, semi)
    review_coverage_set = _coverage_set_from_signals(
        review_sigs,
        signal_key=review_bkey,
        selected_by=review_selected_by,
        exclude_keys=ban_keys,
        expand_mode=review_expand_mode,
        expand_size=expand_size,
    )
    pair_ranked = _rank_signal(
        review_sigs.get("pair_product", review_sigs["support"]),
        review_sigs.get("total_freq"),
        review_sigs.get("auto_freq"),
    )
    win_set = set(winning)
    review_coverage_set["pair_product_diag"] = {
        "core6": pair_ranked[:6],
        "expand24": pair_ranked[:24],
        "core6_count": len(win_set & set(pair_ranked[:6])),
        "expand24_count": len(win_set & set(pair_ranked[:24])),
        "expand_size": 24,
        "note": "로컬 히어로 1:1 핵심식 패리티(매치보너스·세트·평행 제외)",
    }
    review_consensus_coverage = _consensus_coverage(review_sigs, leaderboard)
    review_hit_audit = _coverage_hit_audit(
        review_sigs, review_coverage_set, winning, exclude_keys=ban_keys
    )

    # 이번회차 — 같은 신호 기준으로 '다음 회차' 커버리지 세트.
    cur = _load_current_raw()
    cur_entries = list(cur.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동", include_photo=True)
    cur_semi = _manual_saved_lines(cur_entries, "반자동", include_photo=True)
    current_coverage_set: Dict[str, Any] = {}
    consensus_coverage: Dict[str, Any] = {}
    csig: Dict[str, Dict[int, float]] = {}
    if cur_auto or cur_semi:
        csig = _signals(cur_auto, cur_semi)
        current_coverage_set = _coverage_set_from_signals(
            csig,
            signal_key=bkey,
            selected_by=selected_by,
            exclude_keys=ban_keys,
            expand_mode=expand_mode,
            expand_size=expand_size,
        )
        consensus_coverage = _consensus_coverage(csig, leaderboard)

    # 정직한 요약 — top-6 vs top-18 커버리지 대비.
    best_entry = next((s for s in analysis["signals"] if s["key"] == analysis["best_signal_key"]), None)
    t6 = best_entry["coverage"]["top6"] if best_entry else 0
    t18 = best_entry["coverage"]["top18"] if best_entry else 0

    from .feature_learning_engine import _detect_fixed_semi

    multi_round_backtest = _multi_round_backtest(_samples)
    missed_winner_analysis = _missed_winner_analysis(_samples)
    from .ensemble_backtest import build_ensemble_backtest

    ensemble_backtest = build_ensemble_backtest(_samples)
    summary = {
        "best_top6": t6,
        "best_top18": t18,
        "best_label": best_entry["label"] if best_entry else None,
    }
    inverse_diagnosis = _inverse_diagnosis(
        leaderboard=leaderboard,
        multi_round=multi_round_backtest,
        missed=missed_winner_analysis,
        summary=summary,
        expand_wf=expand_wf,
    )
    honesty = (
        f"{review_round}회 당첨 6개 중 어떤 신호도 top-6 로는 최대 {t6}개만 잡았고, "
        f"top-18 로 넓히면 {t18}개까지 잡혔습니다. 즉 '집중 예측' 은 구조적으로 실패하고 "
        "'넓은 커버리지' 만 유효합니다 — 많이 산 번호(고지지 최상위)는 추첨과 무관하기 "
        "때문입니다. 이는 로또가 균등 무작위라는 사실의 직접 증거이며, 1등 확률"
        "(1/8,145,060)은 어떤 신호로도 변하지 않습니다."
    )
    if review_hit_audit.get("uncatchable"):
        honesty += (
            f" 이번 회차 티켓 미등장 당첨 {review_hit_audit['uncatchable']} "
            f"= 용지 기반 천장({review_hit_audit.get('ceiling_note')})."
        )
    policy = inverse_diagnosis.get("policy") or {}
    from .explain import build_explain_payload

    conf_pct = int(round(float(policy.get("multi_round_confidence") or 0) * 100))
    explain = build_explain_payload(
        subject_type="signal",
        subject_value=bkey,
        decision="coverage",
        honesty=honesty,
        intent="review",
        rounds=[s.round_no for s in _samples],
        algorithms=[
            "best_single",
            "best_of_engines_min_rank",
            "expand_walkforward",
            str(expand_mode),
        ],
        evidence=[
            {
                "kind": "policy",
                "detail": (
                    f"core6={policy.get('core6_mode')} expand18={policy.get('expand18_mode')}"
                    f" variant={policy.get('expand18_variant')}"
                ),
                "weight": 1.0,
            },
            {
                "kind": "backtest",
                "detail": (
                    f"복기 LOO={review_bkey}/{review_expand_mode} · "
                    f"forward multi={bkey}/WF={expand_mode}"
                    f" mean={expand_wf.get('selected_mean')}"
                ),
                "weight": 0.8,
            },
        ],
        confidence={
            "overall": conf_pct,
            "statistics": conf_pct,
            "pattern": 0,
            "model": 0,
            "simulation": 0,
            "backtest": conf_pct,
        },
        backtest={
            "metric": "mean_top18",
            "value": next(
                (
                    e.get("mean_top18")
                    for e in (leaderboard.get("leaderboard") or [])
                    if e.get("key") == leaderboard.get("best_signal_multi")
                ),
                None,
            ),
            "baseline": 18 * 6 / 45,
            "small_sample": bool(leaderboard.get("small_sample")),
        },
        limits=[p.get("title") for p in (inverse_diagnosis.get("problems") or [])],
        improvements=list(inverse_diagnosis.get("actions") or []),
        artifact_versions=["review_verification", "inverse_diagnosis", "10_explain@0.1.0"],
    )

    # 반자동 빈도 신호 — 복기 다회차 검증 + 이번회차 상위 번호(③ 섹션용).
    semi_signal_report = _build_semi_signal_report(
        leaderboard=leaderboard,
        current_sigs=csig,
        current_semi=cur_semi,
        current_fixed=sorted(_detect_fixed_semi(cur_semi)) if cur_semi else [],
    )

    return {
        "ok": True,
        "coverage_build": COVERAGE_BUILD_ID,
        "round_no": review_round,
        "winning_numbers": winning,
        "auto_line_count": len(auto),
        "semi_line_count": len(semi),
        "review_fixed_semi": sorted(_detect_fixed_semi(semi)),
        "current_fixed_semi": sorted(_detect_fixed_semi(cur_semi)) if (cur_auto or cur_semi) else [],
        "signals": analysis["signals"],
        "best_signal_key": analysis["best_signal_key"],
        "current_round_no": int(get_current_round_no()),
        "review_coverage_set": review_coverage_set,
        "review_consensus_coverage": review_consensus_coverage,
        "review_hit_audit": review_hit_audit,
        "review_policy": {
            "signal_key": review_bkey,
            "selected_by": review_selected_by,
            "expand_mode": review_expand_mode,
            "forward_signal_key": bkey,
            "forward_expand_mode": expand_mode,
            "sheet_source": "archived" if archived else "review_saved",
            "auto_line_count": len(auto),
            "semi_line_count": len(semi),
        },
        "expand_walkforward": expand_wf,
        "current_coverage_set": current_coverage_set,
        "consensus_coverage": consensus_coverage,
        "semi_signal_report": semi_signal_report,
        "multi_round_backtest": multi_round_backtest,
        "signal_leaderboard": leaderboard,
        "missed_winner_analysis": missed_winner_analysis,
        "decade_catch": _decade_catch(_samples),
        "ensemble_backtest": ensemble_backtest,
        "inverse_diagnosis": inverse_diagnosis,
        "explain": explain,
        "summary": summary,
        "honesty": honesty,
    }
