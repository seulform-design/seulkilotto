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

# v7: 확장 = review_verification LOO 역산구조(rescue24|30)와 동일 소스.
GRAFT_BUILD_ID = "graft-v7-loo-rescue"

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


def optimize_sharing_from_raw(
    ranked_pool: List[int],
    raw_top6: List[int],
) -> Dict[str, Any] | None:
    """EV이되 raw top6 중 최소 2개 + 상위12 중 4개 유지 — 희소만 쫓다 상위를 버리는 회귀 방지."""
    base = optimize_sharing_recall(ranked_pool, top_window=24, min_from_top12=4)
    if not base:
        return None
    nums = list(base["numbers"])
    top6 = [n for n in raw_top6 if n in set(ranked_pool)][:6]
    have = sum(1 for n in nums if n in set(top6))
    if have >= 2:
        base["mode"] = "recall_ev_top6floor"
        return base
    # top6 에서 부족한 만큼 강제 편입(확장 안·순위 앞선 것부터), 희소 꼬리부터 제거
    need = 2 - have
    add = [n for n in top6 if n not in nums][:need]
    if not add:
        return base
    out = list(nums)
    for n in add:
        # top6 아닌 번호 중 가장 순위 낮은 것 제거
        drop_cands = [x for x in out if x not in set(top6) and x not in add]
        if not drop_cands:
            break
        drop_cands.sort(key=lambda x: ranked_pool.index(x) if x in ranked_pool else 99, reverse=True)
        out.remove(drop_cands[0])
        out.append(n)
    out = sorted(out[:6])
    risk = _assess_sharing_risk(out)
    return {
        "numbers": out,
        "risk": round(risk, 1),
        "ev_score": round(100.0 - risk, 1),
        "rank_sum": float(sum(ranked_pool.index(n) if n in ranked_pool else 99 for n in out)),
        "min_from_top12": 4,
        "mode": "recall_ev_top6floor",
    }


def _build_sets_for_lines(
    auto: List[List[int]],
    semi: List[List[int]],
    *,
    samples=None,
    held_round: int | None = None,
    exclude_keys: List[str] | None = None,
) -> Dict[str, Any] | None:
    """접목 세트 — 확장24/share 는 검증 커버리지(역산·교차검증)와 동일 빌더."""
    from .review_verification import _coverage_set_from_signals, _signals

    present, pair, auto_f, semi_f = _pair_product_rank(auto, semi)
    if len(present) < 6:
        return None
    scores = {n: float(pair.get(n, 0)) for n in present}
    raw_top6 = present[:6]
    ban = list(exclude_keys or ["auto_freq"])
    sigs = _signals(auto, semi)
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="pair_product",
        selected_by="graft",
        exclude_keys=ban,
        expand_mode="single_raw",
        expand_size=24,
        auto_lines=auto,
        semi_lines=semi,
        samples=samples,
        held_round=held_round,
    )
    expand = list(cov.get("expand18") or [])[:24]
    if len(expand) < 6:
        expand = present[:24]
    decade_core = pick_coverage_core6(expand, auto_f, semi_f, scores)
    pure_ev = optimize_sharing_recall(expand, top_window=min(24, len(expand)), min_from_top12=0)
    # 접목 share = 커버리지 share_opt 우선(동일 소스), 없으면 expand+raw 재계산
    cov_share = list(cov.get("share_opt") or [])
    recall_ev = (
        {
            "numbers": cov_share,
            "mode": (cov.get("share_opt_meta") or {}).get("mode") or "recall_ev_top6floor",
            "risk": (cov.get("share_opt_meta") or {}).get("risk"),
            "ev_score": (cov.get("share_opt_meta") or {}).get("ev_score"),
        }
        if len(cov_share) == 6
        else optimize_sharing_from_raw(expand, raw_top6)
    )
    both = sum(1 for n in raw_top6 if auto_f.get(n, 0) > 0 and semi_f.get(n, 0) > 0)
    return {
        "ranked": present,
        "raw_top6": raw_top6,
        "decade_core6": decade_core,
        "core6": raw_top6,  # 하위호환: 기본 핵심 = raw
        "expand24": expand,
        "pure_ev6": (pure_ev or {}).get("numbers") or [],
        "recall_ev6": (recall_ev or {}).get("numbers") or [],
        "recall_ev": recall_ev,
        "both_side_core": both,
        "coverage_build": cov.get("coverage_build"),
        "reverse_graft": cov.get("reverse_graft"),
        "auto_freq": {str(k): v for k, v in auto_f.items() if v > 0},
        "semi_freq": {str(k): v for k, v in semi_f.items() if v > 0},
    }


def _loo_backtest(samples) -> Dict[str, Any]:
    """보관 회차마다 해당 회차 용지만으로 세트 구성 → 당첨 적중(누수 없음)."""
    modes = ("raw_top6", "decade_core6", "expand24", "pure_ev6", "recall_ev6")
    sums = {m: 0 for m in modes}
    per_round: List[Dict[str, Any]] = []
    for s in samples:
        built = _build_sets_for_lines(
            s.auto_lines,
            s.semi_lines,
            samples=samples,
            held_round=int(s.round_no),
            exclude_keys=["auto_freq"],
        )
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
            "decade_core6": built["decade_core6"],
            "expand24": built["expand24"],
            "pure_ev6": built["pure_ev6"],
            "recall_ev6": built["recall_ev6"],
        }
        for m, nums in mapping.items():
            h = _hits(nums, win)
            row["hits"][m] = h
            sums[m] += h
        # 비교용: 구간커버가 raw 대비 놓친 확장 안 당첨
        raw_s = set(built["raw_top6"])
        dec_s = set(built["decade_core6"])
        exp_s = set(built["expand24"])
        row["outside_raw_in_expand"] = sorted(set(win) & exp_s - raw_s)
        row["decade_dropped_vs_raw"] = sorted((set(win) & raw_s) - dec_s)
        per_round.append(row)
    rounds = len(per_round)
    means = {m: round(sums[m] / rounds, 3) if rounds else 0.0 for m in modes}
    random6 = round(6 * 6 / 45, 3)
    random24 = round(24 * 6 / 45, 3)
    small = rounds < 5
    # 구간커버는 raw 대비 **명확한** 이득(+0.25)이고 소표본이 아닐 때만 기본 교체.
    # 1235 실측: 구간커버가 raw(3/6)→2/6 으로 회귀 — 기본은 항상 raw.
    decade_lift = means["decade_core6"] - means["raw_top6"]
    use_decade = (not small) and decade_lift >= 0.25
    advice: List[str] = []
    if use_decade:
        advice.append(
            f"구간커버 평균 {means['decade_core6']}/6 이 raw {means['raw_top6']}/6 보다 "
            f"+{round(decade_lift, 2)} — 예외적으로 구간커버를 핵심에 사용"
        )
    else:
        advice.append(
            f"기본 핵심 = raw 1:1 top6 (평균 {means['raw_top6']}/6). "
            f"구간커버 {means['decade_core6']}/6 는 비교용"
            + (f" · lift {round(decade_lift, 2)}" if rounds else "")
            + (" · 소표본이라 raw 유지" if small else "")
            + " — 1235처럼 구간커버가 6·11·15를 핵심에서 빼던 회귀 방지"
        )
    advice.append(
        f"recall-EV(상위 바닥) 평균 {means['recall_ev6']}/6 · 순수 EV {means['pure_ev6']}/6 "
        "— 기본은 recall-EV(희소만 쫓지 않음)"
    )
    advice.append(
        f"확장(다중엔진형 top24) 평균 {means['expand24']}/6 (무작위≈{random24}) — 넓은 그물이 본령"
    )
    return {
        "ok": rounds >= 1,
        "rounds": rounds,
        "small_sample": small,
        "means": means,
        "random_baseline": {"top6": random6, "top24": random24},
        "per_round": per_round,
        "selected_core_mode": "decade_core6" if use_decade else "raw_top6",
        "selected_ev_mode": "recall_ev6",
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

    built = _build_sets_for_lines(
        auto,
        semi,
        samples=samples,
        held_round=review_round if intent == "review" else None,
        exclude_keys=["auto_freq"],
    )
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

    core_mode = backtest.get("selected_core_mode") or "raw_top6"
    core6 = (
        built["decade_core6"]
        if core_mode == "decade_core6"
        else built["raw_top6"]
    )
    share = built["recall_ev"] or optimize_sharing_from_raw(
        built["expand24"], built["raw_top6"]
    )

    win_set = set(winning)
    audit = None
    if winning:
        exp_s = set(built["expand24"])
        core_s = set(core6)
        raw_s = set(built["raw_top6"])
        dec_s = set(built["decade_core6"])
        audit = {
            "winning": winning,
            "raw_top6_hits": _hits(built["raw_top6"], winning),
            "decade_core6_hits": _hits(built["decade_core6"], winning),
            "selected_core6_hits": _hits(core6, winning),
            "expand24_hits": _hits(built["expand24"], winning),
            "pure_ev6_hits": _hits(built["pure_ev6"], winning),
            "recall_ev6_hits": _hits(built["recall_ev6"], winning),
            # 선택 핵심 기준 밖·확장 안
            "outside_core_in_expand": sorted(win_set & exp_s - core_s),
            "outside_expand": sorted(win_set - exp_s),
            # 회귀 진단: 구간커버가 raw 당첨을 핵심에서 뺀 번호
            "decade_dropped_vs_raw": sorted((win_set & raw_s) - dec_s),
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
                "구간커버 핵심6"
                if core_mode == "decade_core6"
                else "raw 1:1 top6 (기본)"
            ),
            "ev_mode": "recall_ev_top6floor",
            "ev_mode_label": "분산최적 + 상위12≥4 + raw top6≥2",
            "expand_mode": "multi_engine_reverse_graft",
            "coverage_build": built.get("coverage_build"),
            "note": (
                "확장24=검증 커버리지와 동일(전엔진교차검증+일치레벨역산). "
                "당첨은 순위 미사용(복기 사후 대조만). 평행·이월 forward OFF."
            ),
        },
        "reverse_graft": built.get("reverse_graft"),
        "raw_top6": built["raw_top6"],
        "core6": core6,
        "decade_core6": built["decade_core6"],
        "expand24": built["expand24"],
        "share_opt": (share or {}).get("numbers") or built["recall_ev6"],
        "share_meta": share,
        "pure_ev6": built["pure_ev6"],
        "both_side_core": built["both_side_core"],
        "audit": audit,
        "backtest": backtest,
        "honesty": (
            "1등 확률(1/8,145,060)은 불변. 기본 핵심·확장은 1:1 raw(잘 잡히던 추출식). "
            "구간커버가 raw 적중을 깎는 회귀(예: 1235 3/6→2/6)는 기본에서 배제한다."
        ),
    }
