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
    ac = _line_freq(auto)
    sc = _line_freq(semi)
    support = {n: float(min(ac.get(n, 0), sc.get(n, 0))) for n in range(1, 46)}
    total = {n: float(ac.get(n, 0) + sc.get(n, 0)) for n in range(1, 46)}
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
    return {
        "support": support,
        "auto_freq": {n: float(ac.get(n, 0)) for n in range(1, 46)},
        "total_freq": total,
        "balanced": balanced_val,
    }


_SIGNAL_LABELS = {
    "support": "양쪽 지지(자동∩반자동)",
    "auto_freq": "자동 빈도",
    "total_freq": "전체 빈도(자동+반자동)",
    "balanced": "구간 균형 커버리지",
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

    # 이번회차 — 같은 신호로 '커버리지 세트' 를 제시(집중 top-6 + 확장 top-18).
    cur = _load_current_raw()
    cur_entries = list(cur.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동", include_photo=True)
    cur_semi = _manual_saved_lines(cur_entries, "반자동", include_photo=True)
    current_coverage_set: Dict[str, Any] = {}
    if cur_auto or cur_semi:
        csig = _signals(cur_auto, cur_semi)
        # best_signal 로 확인된 신호를 이번회차에 적용.
        bkey = analysis.get("best_signal_key") or "support"
        ranked = _rank_signal(csig.get(bkey, csig["support"]))
        current_coverage_set = {
            "signal": bkey,
            "signal_label": _SIGNAL_LABELS.get(bkey, bkey),
            "core6": ranked[:6],
            "expand18": ranked[:18],
        }

    # 정직한 요약 — top-6 vs top-18 커버리지 대비.
    best_entry = next((s for s in analysis["signals"] if s["key"] == analysis["best_signal_key"]), None)
    t6 = best_entry["coverage"]["top6"] if best_entry else 0
    t18 = best_entry["coverage"]["top18"] if best_entry else 0

    return {
        "ok": True,
        "round_no": review_round,
        "winning_numbers": winning,
        "auto_line_count": len(auto),
        "semi_line_count": len(semi),
        "signals": analysis["signals"],
        "best_signal_key": analysis["best_signal_key"],
        "current_round_no": int(get_current_round_no()),
        "current_coverage_set": current_coverage_set,
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
