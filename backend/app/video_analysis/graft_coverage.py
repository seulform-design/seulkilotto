"""강수·기대 접목 커버리지 · EV — 서버 권위 소스 + LOO 백테스트.

프론트 로컬 graft 가 배포/캐시로 옛 top6 에 머물던 회귀를 막기 위해,
복기 용지 1:1 곱(pair_product) → 구간커버 핵심6 · 확장24 · recall-EV 를
서버에서 계산하고, 보관 회차 LOO 로 모드별 recall 을 검증한다.

⚠️ 확률(1/8,145,060) 불변 — recall·EV 만 개선·보고.
"""
from __future__ import annotations

import math
from itertools import combinations
from typing import Any, Dict, List, Sequence, Tuple

GRAFT_BUILD_ID = "graft-v2-api"

DECADE_LABELS = ("단번대", "10번대", "20번대", "30번대", "40번대")


def _decade(n: int) -> int:
    return min(4, (int(n) - 1) // 10)


def _line_freq(lines: Sequence[Sequence[int]]) -> Dict[int, float]:
    c: Dict[int, float] = {n: 0.0 for n in range(1, 46)}
    for line in lines:
        for n in set(int(x) for x in line if 1 <= int(x) <= 45):
            c[n] += 1.0
    return c


def _pair_product_rank(
    auto: List[List[int]], semi: List[List[int]]
) -> Tuple[List[int], Dict[int, float], Dict[int, float], Dict[int, float]]:
    """로컬 predictedNumbers 1:1 핵심식 — log2(a+1)*log2(s+1)*4 (고정수 제외)."""
    from .feature_learning_engine import _detect_fixed_semi
    from .review_verification import _rank_signal

    ac = _line_freq(auto)
    sc = _line_freq(semi)
    fixed = _detect_fixed_semi(semi)
    sc_sup = {n: (0.0 if n in fixed else float(sc.get(n, 0))) for n in range(1, 46)}
    pair = {
        n: math.log2(float(ac.get(n, 0)) + 1.0) * math.log2(sc_sup[n] + 1.0) * 4.0
        for n in range(1, 46)
    }
    total = {n: float(ac.get(n, 0) + sc_sup[n]) for n in range(1, 46)}
    auto_f = {n: float(ac.get(n, 0)) for n in range(1, 46)}
    ranked = _rank_signal(pair, total, auto_f)
    # 티켓 미등장(점수 0)은 뒤로 — 확장/핵심 후보에서 실질 제외
    present = [n for n in ranked if total.get(n, 0) > 0]
    return present, pair, auto_f, sc_sup


def _support_pick_key(n: int, auto: Dict[int, float], semi: Dict[int, float], score: float) -> float:
    a = float(auto.get(n, 0))
    s = float(semi.get(n, 0))
    both = 1.0 if a > 0 and s > 0 else 0.0
    return both * 1000.0 + min(a, s) * 50.0 + score


def pick_coverage_core6(
    expand_ranked: List[int],
    auto: Dict[int, float],
    semi: Dict[int, float],
    scores: Dict[int, float],
) -> List[int]:
    present = {n for n in expand_ranked if auto.get(n, 0) > 0 or semi.get(n, 0) > 0}
    order = sorted(
        expand_ranked,
        key=lambda n: (-_support_pick_key(n, auto, semi, scores.get(n, 0.0)), n),
    )
    result: List[int] = []
    decade_count: Dict[int, int] = {}
    covered: set = set()

    def effective(n: int) -> float:
        if n not in present:
            return -1.0
        d = _decade(n)
        if decade_count.get(d, 0) >= 2:
            return -1.0
        bonus = 0.0 if d in covered else 500.0
        return _support_pick_key(n, auto, semi, scores.get(n, 0.0)) + bonus

    while len(result) < 6:
        best, best_s = None, -1.0
        for n in order:
            if n in result:
                continue
            s = effective(n)
            if s > best_s:
                best_s, best = s, n
        if best is None or best_s < 0:
            break
        result.append(best)
        d = _decade(best)
        decade_count[d] = decade_count.get(d, 0) + 1
        covered.add(d)
    for n in order:
        if len(result) >= 6:
            break
        if n not in result:
            result.append(n)
    return sorted(result[:6])


def balance_expand_net(order: List[int], core: List[int], size: int = 24) -> List[int]:
    present = set(order)
    result: List[int] = []
    seen: set = set()
    for n in order:
        if n in core and n not in seen:
            result.append(n)
            seen.add(n)
    covered = {_decade(n) for n in result}
    for d in range(5):
        if d in covered:
            continue
        for n in order:
            if n in seen or n not in present or _decade(n) != d:
                continue
            result.append(n)
            seen.add(n)
            covered.add(d)
            break
    for n in order:
        if len(result) >= size:
            break
        if n not in seen:
            result.append(n)
            seen.add(n)
    return result[:size]


def _assess_sharing_risk(numbers: List[int]) -> float:
    """프론트 assessJackpotSharing risk 휴리스틱 축소판(낮을수록 EV 유리)."""
    valid = sorted({int(n) for n in numbers if 1 <= int(n) <= 45})
    if len(valid) != 6:
        return 50.0
    risk = 40.0
    le31 = sum(1 for n in valid if n <= 31)
    if le31 >= 5:
        risk += (le31 - 4) * 8 + (14 if le31 == 6 else 0)
    elif le31 <= 2:
        risk -= (3 - le31) * 6
    # 연속
    run = 1
    best_run = 1
    for i in range(1, 6):
        if valid[i] == valid[i - 1] + 1:
            run += 1
            best_run = max(best_run, run)
        else:
            run = 1
    if best_run >= 3:
        risk += (best_run - 2) * 10
    odds = sum(1 for n in valid if n % 2)
    if odds in (0, 6):
        risk -= 8
    high = sum(1 for n in valid if n >= 32)
    if high >= 4:
        risk -= (high - 3) * 5
    if high == 0:
        risk += 10
    return max(0.0, min(100.0, risk))


def optimize_sharing_recall(
    ranked_pool: List[int],
    *,
    top_window: int = 24,
    min_from_top12: int = 4,
) -> Dict[str, Any] | None:
    """분산최적 + 상위 순위 바닥 — 순수 EV가 6·11 등 상위 적중을 버리던 회귀 보정.

    top12 에서 min_from_top12 개 이상 포함한 6조합만 후보로, risk↓ · rankSum↓.
    """
    pool = []
    seen = set()
    for n in ranked_pool:
        n = int(n)
        if n in seen or not (1 <= n <= 45):
            continue
        seen.add(n)
        pool.append(n)
    if len(pool) < 6:
        return None
    window = pool[: max(6, min(top_window, len(pool)))]
    top12 = set(window[: min(12, len(window))])
    rank_index = {n: i for i, n in enumerate(window)}
    best: Tuple[float, float, List[int]] | None = None  # risk, rankSum, nums
    for combo in combinations(window, 6):
        nums = list(combo)
        if sum(1 for n in nums if n in top12) < min_from_top12:
            continue
        risk = _assess_sharing_risk(nums)
        rank_sum = float(sum(rank_index.get(n, 99) for n in nums))
        key = (risk, rank_sum)
        if best is None or key < (best[0], best[1]):
            best = (risk, rank_sum, sorted(nums))
    if best is None:
        # 폴백 — 제약 완화
        for combo in combinations(window, 6):
            nums = list(combo)
            risk = _assess_sharing_risk(nums)
            rank_sum = float(sum(rank_index.get(n, 99) for n in nums))
            if best is None or (risk, rank_sum) < (best[0], best[1]):
                best = (risk, rank_sum, sorted(nums))
    if best is None:
        return None
    risk, rank_sum, nums = best
    return {
        "numbers": nums,
        "risk": round(risk, 1),
        "ev_score": round(100.0 - risk, 1),
        "rank_sum": rank_sum,
        "min_from_top12": min_from_top12,
        "mode": "recall_ev",
    }


def _hits(nums: Sequence[int], winning: Sequence[int]) -> int:
    return len(set(nums) & set(winning))


def _build_sets_for_lines(
    auto: List[List[int]], semi: List[List[int]]
) -> Dict[str, Any] | None:
    present, pair, auto_f, semi_f = _pair_product_rank(auto, semi)
    if len(present) < 6:
        return None
    scores = {n: float(pair.get(n, 0)) for n in present}
    # graftScore 순위 ≈ present 순서
    raw_top6 = present[:6]
    raw_expand = present[: min(24, len(present))]
    core6 = pick_coverage_core6(raw_expand, auto_f, semi_f, scores)
    expand = balance_expand_net(raw_expand, core6, 24)
    pure_ev = optimize_sharing_recall(expand, top_window=24, min_from_top12=0)
    recall_ev = optimize_sharing_recall(expand, top_window=24, min_from_top12=4)
    both = sum(1 for n in core6 if auto_f.get(n, 0) > 0 and semi_f.get(n, 0) > 0)
    return {
        "ranked": present,
        "raw_top6": raw_top6,
        "core6": core6,
        "expand24": expand,
        "pure_ev6": (pure_ev or {}).get("numbers") or [],
        "recall_ev6": (recall_ev or {}).get("numbers") or [],
        "recall_ev": recall_ev,
        "both_side_core": both,
        "auto_freq": {str(k): v for k, v in auto_f.items() if v > 0},
        "semi_freq": {str(k): v for k, v in semi_f.items() if v > 0},
    }


def _loo_backtest(samples) -> Dict[str, Any]:
    """보관 회차마다 해당 회차 용지만으로 세트 구성 → 당첨 적중(누수 없음)."""
    modes = ("raw_top6", "decade_core6", "expand24", "pure_ev6", "recall_ev6")
    sums = {m: 0 for m in modes}
    per_round: List[Dict[str, Any]] = []
    for s in samples:
        built = _build_sets_for_lines(s.auto_lines, s.semi_lines)
        if not built:
            continue
        win = list(s.winning)
        row = {
            "round_no": s.round_no,
            "auto_lines": len(s.auto_lines),
            "semi_lines": len(s.semi_lines),
            "hits": {},
        }
        mapping = {
            "raw_top6": built["raw_top6"],
            "decade_core6": built["core6"],
            "expand24": built["expand24"],
            "pure_ev6": built["pure_ev6"],
            "recall_ev6": built["recall_ev6"],
        }
        for m, nums in mapping.items():
            h = _hits(nums, win)
            row["hits"][m] = h
            sums[m] += h
        # 핵심 밖·확장 안 당첨
        core_s = set(built["core6"])
        exp_s = set(built["expand24"])
        row["outside_core_in_expand"] = sorted(set(win) & exp_s - core_s)
        per_round.append(row)
    rounds = len(per_round)
    means = {m: round(sums[m] / rounds, 3) if rounds else 0.0 for m in modes}
    random6 = round(6 * 6 / 45, 3)
    random24 = round(24 * 6 / 45, 3)
    # 권고: decade_core vs raw, recall_ev vs pure_ev
    advice: List[str] = []
    if rounds and means["decade_core6"] + 1e-9 >= means["raw_top6"]:
        advice.append(
            f"구간커버 핵심6 평균 {means['decade_core6']}/6 ≥ raw top6 {means['raw_top6']}/6 "
            "→ 핵심은 구간커버를 기본으로 유지"
        )
    elif rounds:
        advice.append(
            f"이 표본에선 raw top6({means['raw_top6']})이 구간커버({means['decade_core6']})보다 "
            "높음 — 소표본·용지 위상 차이 가능, 둘 다 표시"
        )
    if rounds and means["recall_ev6"] + 1e-9 >= means["pure_ev6"]:
        advice.append(
            f"recall-EV 평균 {means['recall_ev6']}/6 ≥ 순수 EV {means['pure_ev6']}/6 "
            "→ EV는 상위12 바닥(4개) 유지 모드 사용"
        )
    else:
        advice.append(
            f"순수 EV({means.get('pure_ev6')})가 recall-EV보다 적중 우세할 수 있으나 "
            "상위 번호를 버려 확장망 대비 손실이 큼 — 기본은 recall-EV"
        )
    advice.append(
        f"확장24 평균 {means['expand24']}/6 (무작위≈{random24}) — 집중보다 넓은 그물이 본령"
    )
    return {
        "ok": rounds >= 1,
        "rounds": rounds,
        "small_sample": rounds < 5,
        "means": means,
        "random_baseline": {"top6": random6, "top24": random24},
        "per_round": per_round,
        "selected_core_mode": (
            "decade_core6"
            if means["decade_core6"] + 1e-9 >= means["raw_top6"]
            else "raw_top6"
        ),
        "selected_ev_mode": (
            "recall_ev6"
            if means["recall_ev6"] + 1e-9 >= means["pure_ev6"]
            else "recall_ev6"  # 정책: 적중이 비슷해도 recall-EV 유지
        ),
        "advice": advice,
    }


def build_graft_coverage(*, intent: str = "review") -> Dict[str, Any]:
    from .store import (
        _review_entries_for_round,
        _manual_saved_lines,
        _load_current_raw,
    )
    from .draw_template import get_review_round_no, get_current_round_no
    from ..database import load_history
    from .feature_learning_engine import collect_round_samples

    intent = intent if intent in ("review", "current_round") else "review"
    review_round = int(get_review_round_no())
    current_round = int(get_current_round_no())
    target_round = review_round if intent == "review" else current_round

    samples = collect_round_samples()
    backtest = _loo_backtest(samples)

    if intent == "review":
        archived, review_saved = _review_entries_for_round(review_round)
        src = archived if archived else review_saved
        sheet_source = "archived" if archived else "review_saved"
        src = [{**e, "video_intent": "review"} for e in src]
        auto = _manual_saved_lines(src, "자동", include_photo=True)
        semi = _manual_saved_lines(src, "반자동", include_photo=True)
    else:
        cur = _load_current_raw()
        entries = list(cur.get("entries") or [])
        auto = _manual_saved_lines(entries, "자동", include_photo=True)
        semi = _manual_saved_lines(entries, "반자동", include_photo=True)
        sheet_source = "current_raw"

    if not auto and not semi:
        return {
            "ok": False,
            "reason": f"{target_round}회 {intent} 용지가 없어 접목을 만들 수 없습니다.",
            "graft_build": GRAFT_BUILD_ID,
            "intent": intent,
            "round_no": target_round,
            "backtest": backtest,
        }

    built = _build_sets_for_lines(auto, semi)
    if not built:
        return {
            "ok": False,
            "reason": "1:1 등장 번호가 6개 미만입니다.",
            "graft_build": GRAFT_BUILD_ID,
            "intent": intent,
            "round_no": target_round,
            "backtest": backtest,
        }

    winning: List[int] = []
    if intent == "review":
        df = load_history()
        if not df.empty:
            row = df[df["round"].astype(int) == review_round]
            if not row.empty:
                r0 = row.sort_values("round").iloc[-1]
                winning = [int(r0[f"num{i}"]) for i in range(1, 7)]

    core_mode = backtest.get("selected_core_mode") or "decade_core6"
    ev_mode = backtest.get("selected_ev_mode") or "recall_ev6"
    core6 = built["core6"] if core_mode == "decade_core6" else built["raw_top6"]
    # 백테스트가 raw 를 골라도 구간커버를 함께 노출(비교용)
    share = built["recall_ev"] if ev_mode == "recall_ev6" else None
    if share is None:
        share = optimize_sharing_recall(built["expand24"], min_from_top12=4)

    win_set = set(winning)
    audit = None
    if winning:
        exp_s = set(built["expand24"])
        core_s = set(core6)
        audit = {
            "winning": winning,
            "raw_top6_hits": _hits(built["raw_top6"], winning),
            "decade_core6_hits": _hits(built["core6"], winning),
            "selected_core6_hits": _hits(core6, winning),
            "expand24_hits": _hits(built["expand24"], winning),
            "pure_ev6_hits": _hits(built["pure_ev6"], winning),
            "recall_ev6_hits": _hits(built["recall_ev6"], winning),
            "outside_core_in_expand": sorted(win_set & exp_s - core_s),
            "outside_expand": sorted(win_set - exp_s),
        }

    from .feature_learning_engine import _detect_fixed_semi

    return {
        "ok": True,
        "graft_build": GRAFT_BUILD_ID,
        "intent": intent,
        "round_no": target_round,
        "current_round_no": current_round,
        "review_round_no": review_round,
        "data_used": {
            "sheet_source": sheet_source,
            "auto_line_count": len(auto),
            "semi_line_count": len(semi),
            "fixed_semi_excluded": sorted(_detect_fixed_semi(semi)),
            "signal": "pair_product",
            "signal_label": "1:1 곱(자동×반자동 log)",
            "core_mode": core_mode,
            "core_mode_label": (
                "구간커버 핵심6 (미커버 가산·양쪽 지지)"
                if core_mode == "decade_core6"
                else "raw 1:1 top6"
            ),
            "ev_mode": "recall_ev",
            "ev_mode_label": "분산최적 + 상위12 중 4개 이상 유지",
            "expand_mode": "balance_expand24",
            "note": (
                "당첨번호는 순위 계산에 미사용(복기는 사후 대조만). "
                "평행·이월 forward 미주입."
            ),
        },
        "raw_top6": built["raw_top6"],
        "core6": core6,
        "decade_core6": built["core6"],
        "expand24": built["expand24"],
        "share_opt": (share or {}).get("numbers") or built["recall_ev6"],
        "share_meta": share,
        "pure_ev6": built["pure_ev6"],
        "both_side_core": built["both_side_core"],
        "audit": audit,
        "backtest": backtest,
        "honesty": (
            "1등 확률(1/8,145,060)은 불변. 접목은 recall(그물이 당첨을 담는 폭)과 "
            "EV(당첨 시 공동당첨 회피)만 다룬다. LOO 백테스트로 핵심/EV 모드를 고른다."
        ),
    }
