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

from collections import Counter
from typing import Any, Dict, List

COVERAGE_KS = [6, 10, 15, 18, 24, 30]


def _rank_signal(values: Dict[int, float]) -> List[int]:
    """값 내림차순(동률은 번호 오름차순)으로 45개 번호를 정렬한 랭킹."""
    return sorted(range(1, 46), key=lambda n: (-values.get(n, 0.0), n))


def _line_freq(lines: List[List[int]]) -> Counter:
    c: Counter = Counter()
    for ln in lines:
        for n in {int(x) for x in ln if 1 <= int(x) <= 45}:
            c[n] += 1
    return c


def _signals(auto: List[List[int]], semi: List[List[int]]) -> Dict[str, Dict[int, float]]:
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
    # 균형: 지지 점수에 구간(10단위) 상한을 둬 한 구간 쏠림을 억제한 커버리지 지향 신호.
    balanced_order = _rank_signal(support)
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

    return {
        "support": support,
        "auto_freq": {n: float(ac.get(n, 0)) for n in range(1, 46)},
        "total_freq": total,
        "balanced": balanced_val,
        "combo_strength": combo_strength,
    }


_SIGNAL_LABELS = {
    "support": "양쪽 지지(자동∩반자동)",
    "auto_freq": "자동 빈도",
    "total_freq": "전체 빈도(자동+반자동)",
    "balanced": "구간 균형 커버리지",
    "combo_strength": "조합 강도(반복줄×lift)",
}


def _analyze(auto: List[List[int]], semi: List[List[int]], winning: List[int]) -> Dict[str, Any]:
    win_set = set(winning)
    sigs = _signals(auto, semi)
    out_signals: List[Dict[str, Any]] = []
    best = None
    for key, vals in sigs.items():
        ranked = _rank_signal(vals)
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
        }
        for k in ks
    }
    return {"rounds": len(samples), "per_round": per_round, "aggregate": aggregate}


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
    agg = {sk: {6: 0, 18: 0} for sk in keys}
    tiers = {sk: {"t6": 0, "t18": 0, "t30": 0, "out": 0} for sk in keys}
    for s in samples:
        sigs = _signals(s.auto_lines, s.semi_lines)
        win = list(s.winning)
        for sk in keys:
            ranked = _rank_signal(sigs[sk])
            pos = {n: ranked.index(n) + 1 for n in win}
            agg[sk][6] += sum(1 for n in win if pos[n] <= 6)
            agg[sk][18] += sum(1 for n in win if pos[n] <= 18)
            for n in win:
                r = pos[n]
                if r <= 6:
                    tiers[sk]["t6"] += 1
                elif r <= 18:
                    tiers[sk]["t18"] += 1
                elif r <= 30:
                    tiers[sk]["t30"] += 1
                else:
                    tiers[sk]["out"] += 1
    n = max(1, len(samples))
    leaderboard = sorted(
        (
            {
                "key": sk,
                "label": _SIGNAL_LABELS.get(sk, sk),
                "mean_top6": round(agg[sk][6] / n, 3),
                "mean_top18": round(agg[sk][18] / n, 3),
                "tiers": tiers[sk],
            }
            for sk in keys
        ),
        key=lambda x: (-x["mean_top18"], -x["mean_top6"], x["key"]),
    )
    return {
        "rounds": len(samples),
        "leaderboard": leaderboard,
        "best_signal_multi": leaderboard[0]["key"] if (leaderboard and samples) else None,
    }


def _consensus_coverage(
    cur_signals: Dict[str, Dict[int, float]], leaderboard: Dict[str, Any]
) -> Dict[str, Any]:
    """이번회차 커버리지를 '검증 통과 신호들의 합의'로 만든다 — 단일 신호가 아니라, 복기서
    당첨을 무작위 이상으로 잡았던 신호들이 **함께** 상위로 가리키는 번호를 위로 올린다.

    good 신호 = 다회차 상위18 평균이 무작위 기대(2.4) 초과. 각 번호가 몇 개 good 신호의
    top-18 에 들었나(agreement)로 정렬 → '여러 신호가 동의할수록 핵심'. 과거 회차 성적만
    사용(누수 없음). 확률 불변 — 넓은 합의 표시용.
    """
    lb = leaderboard.get("leaderboard", []) or []
    random_top18 = 18 * 6 / 45  # ≈ 2.4
    good = [
        e["key"] for e in lb
        if float(e.get("mean_top18", 0)) > random_top18 and e["key"] in cur_signals
    ]
    if len(good) < 2:  # 무작위 초과 신호가 부족하면 성적 상위 3개로 폴백
        good = [e["key"] for e in lb[:3] if e["key"] in cur_signals]
    if not good:
        return {}
    agree = {n: 0 for n in range(1, 46)}
    best_rank = {n: 99 for n in range(1, 46)}
    for key in good:
        ranked = _rank_signal(cur_signals[key])
        for i, n in enumerate(ranked):
            if i < 18:
                agree[n] += 1
            best_rank[n] = min(best_rank[n], i + 1)
    order = sorted(range(1, 46), key=lambda n: (-agree[n], best_rank[n], n))
    need = max(2, len(good) // 2 + 1)  # 엄격 과반(예: good 4 → 3) good 신호 동의
    core = [n for n in order if agree[n] >= need][:6]
    if len(core) < 6:
        core = order[:6]
    expand = order[:18]
    return {
        "good_signal_count": len(good),
        "good_signals": good,
        "core6": core,
        "expand18": expand,
        "agreement": {str(n): agree[n] for n in expand},
        "need": need,
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
        rank_pos = {k: {n: i + 1 for i, n in enumerate(_rank_signal(sigs[k]))} for k in keys}
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

    # 이번회차 — 같은 신호로 '커버리지 세트' 를 제시(집중 top-6 + 확장 top-18).
    cur = _load_current_raw()
    cur_entries = list(cur.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동", include_photo=True)
    cur_semi = _manual_saved_lines(cur_entries, "반자동", include_photo=True)
    current_coverage_set: Dict[str, Any] = {}
    consensus_coverage: Dict[str, Any] = {}
    if cur_auto or cur_semi:
        csig = _signals(cur_auto, cur_semi)
        # 커버리지 신호를 '다회차 성적'(당첨을 가장 잘 잡은 신호)으로 선택 — 단일회차 best
        # 는 우연에 흔들린다. 폴백: 단일회차 best → support.
        multi_key = leaderboard.get("best_signal_multi")
        bkey = multi_key or analysis.get("best_signal_key") or "support"
        ranked = _rank_signal(csig.get(bkey, csig["support"]))
        current_coverage_set = {
            "signal": bkey,
            "signal_label": _SIGNAL_LABELS.get(bkey, bkey),
            "selected_by": "multi_round" if multi_key else "single_round",
            "core6": ranked[:6],
            "expand18": ranked[:18],
        }
        # 다중신호 합의 — 검증 통과 신호들이 함께 가리키는 번호(단일 신호보다 강건).
        consensus_coverage = _consensus_coverage(csig, leaderboard)

    # 정직한 요약 — top-6 vs top-18 커버리지 대비.
    best_entry = next((s for s in analysis["signals"] if s["key"] == analysis["best_signal_key"]), None)
    t6 = best_entry["coverage"]["top6"] if best_entry else 0
    t18 = best_entry["coverage"]["top18"] if best_entry else 0

    from .feature_learning_engine import _detect_fixed_semi

    return {
        "ok": True,
        "round_no": review_round,
        "winning_numbers": winning,
        "auto_line_count": len(auto),
        "semi_line_count": len(semi),
        "review_fixed_semi": sorted(_detect_fixed_semi(semi)),
        "current_fixed_semi": sorted(_detect_fixed_semi(cur_semi)) if (cur_auto or cur_semi) else [],
        "signals": analysis["signals"],
        "best_signal_key": analysis["best_signal_key"],
        "current_round_no": int(get_current_round_no()),
        "current_coverage_set": current_coverage_set,
        "consensus_coverage": consensus_coverage,
        "multi_round_backtest": _multi_round_backtest(_samples),
        "signal_leaderboard": leaderboard,
        "missed_winner_analysis": _missed_winner_analysis(_samples),
        "summary": {
            "best_top6": t6,
            "best_top18": t18,
            "best_label": best_entry["label"] if best_entry else None,
        },
        "honesty": (
            f"{review_round}회 당첨 6개 중 어떤 신호도 top-6 로는 최대 {t6}개만 잡았고, "
            f"top-18 로 넓히면 {t18}개까지 잡혔습니다. 즉 '집중 예측' 은 구조적으로 실패하고 "
            "'넓은 커버리지' 만 유효합니다 — 많이 산 번호(고지지 최상위)는 추첨과 무관하기 "
            "때문입니다. 이는 로또가 균등 무작위라는 사실의 직접 증거이며, 1등 확률"
            "(1/8,145,060)은 어떤 신호로도 변하지 않습니다."
        ),
    }
