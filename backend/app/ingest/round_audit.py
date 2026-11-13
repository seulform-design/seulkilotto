"""회차별 후보군 성적 감사 — 전 회차 예측 기록(백테스트·사전 예측)에서 후보군(엔진)별 '당첨 확률'
(일치 분포·3개 이상·등수)이 무작위보다 떨어지는지 확인하고, 떨어지면 원인을 진단해 자동 보정(투표 제외)한다.

원칙
- 입력은 round_prediction_history + round_prediction_evaluation(공식 결과 대조)뿐. 기록을 지우거나 바꾸지 않는다.
- 비교 기준: 게임당 일치 수 ~ 초기하(6, 39, 6) (평균 0.8, 3개 이상 1.77%), 그리고 같은 조합 수 무작위 구매.
- 여러 후보군을 동시에 검정하므로 Bonferroni 보정. 보정 후에도 유의하게 낮을 때만 '하락'으로 판정한다.
- 보정은 '추가·가역'만: 하락 후보군을 V12 투표에서 빼는 조치(round_audit_actions)를 기록하고, 원본 엔진·기록은 그대로.
  다음 감사에서 해소되면 자동 해제. 조치는 감사 이후 만들어지는 live 후보에만 적용(과거 백테스트는 재계산하지 않음 → 누수 없음).
- 공정·독립 추첨에서 어떤 6개 조합도 1등 확률은 1/8,145,060 이다. 감사·보정은 이 확률을 올리지 않는다.
"""
from __future__ import annotations

import math
import uuid
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from . import db

EXP = 0.8
VAR1 = 6 * (6 / 45) * (39 / 45) * (39 / 44)
P3 = 0.017650  # 3개 이상 일치 확률(초기하)
TIER_LABEL = {1: "1등", 2: "2등", 3: "3등", 4: "4등", 5: "5등"}
NOT_AUDITED = {"random_baseline"}  # 기준선 자체는 비교 대상
_TABLE = """CREATE TABLE IF NOT EXISTS round_audit_actions (
    action_id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    metrics_json TEXT,
    active INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    released_at TEXT
)"""
_READY: Dict[str, bool] = {}

Rec = Tuple[int, List[int], int, int, Optional[int]]  # (rank, numbers, match, bonus, tier)


def _ensure() -> None:
    key = db.backend()
    if _READY.get(key):
        return
    from . import predictions as P

    P._ensure()
    with db.transaction() as c:
        c.execute(_TABLE)
    _READY[key] = True


def reset_for_tests() -> None:
    _READY.clear()


def _sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2))


def _records() -> Dict[Tuple[str, str], Dict[int, List[Rec]]]:
    """(type, method) → round → [(rank, numbers, match, bonus, tier)]. 격리(V8) 행은 제외."""
    try:
        from . import reverse_analysis as R

        R._ensure()
        quarantined = R._quarantined()
    except Exception:  # noqa: BLE001
        quarantined = set()
    rows = db.query("SELECT h.prediction_id, h.prediction_type, h.prediction_method, h.draw_round, h.prediction_rank, "
                    "h.predicted_numbers, e.match_count, e.bonus_matched, e.prize_tier FROM round_prediction_history h "
                    "JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id WHERE h.prediction_status <> 'superseded'")
    out: Dict[Tuple[str, str], Dict[int, List[Rec]]] = {}
    for pid, t, m, r, rank, nums, mc, bm, tier in rows:
        if pid in quarantined:
            continue
        out.setdefault((t, m), {}).setdefault(int(r), []).append(
            (int(rank), sorted(int(x) for x in db.loads(nums)), int(mc), int(bm or 0), tier))
    return out


def _structure_rates(picks: List[List[int]], lo: int, hi: int) -> Dict[str, float]:
    n = max(1, len(picks))

    def decade_max(p):
        return max(Counter(min(x // 10, 4) for x in p).values())

    return {"sum_out": sum(1 for p in picks if not lo <= sum(p) <= hi) / n,
            "odd_extreme": sum(1 for p in picks if sum(x % 2 for x in p) in (0, 6)) / n,
            "consec2": sum(1 for p in picks if sum(1 for a, b in zip(p, p[1:]) if b - a == 1) >= 2) / n,
            "decade4": sum(1 for p in picks if decade_max(p) >= 4) / n}


def _structure_reference(draws) -> Dict[str, float]:
    """실제 당첨번호의 구조 분포(비교 기준)."""
    sums = sorted(sum(d.numbers) for d in draws)
    lo, hi = sums[int(len(sums) * 0.025)], sums[max(0, int(len(sums) * 0.975) - 1)]
    return {"sum_lo": lo, "sum_hi": hi, **_structure_rates([sorted(d.numbers) for d in draws], lo, hi)}


def _random_best_of(k: int, sims: int, seed: int) -> np.ndarray:
    """회차당 k 조합 무작위 구매의 '최고 일치 수' 분포."""
    g = np.random.default_rng(seed)
    return g.hypergeometric(6, 39, 6, size=(sims, k)).max(axis=1)


def _mean_of(by_round: Dict[int, List[Rec]], rounds: List[int]) -> Tuple[Optional[float], int]:
    ms = [g[2] for r in rounds for g in by_round[r]]
    return (sum(ms) / len(ms) if ms else None), len(ms)


def _method_report(method: str, ptype: str, by_round: Dict[int, List[Rec]], win: Dict[int, set],
                   prev_of: Dict[int, List[int]], ref: Dict[str, float]) -> Dict[str, Any]:
    from .predictions import METHOD_LABELS

    rounds = sorted(by_round)
    games = [g for r in rounds for g in by_round[r]]
    n = len(games)
    matches = [g[2] for g in games]
    mean = sum(matches) / n
    se = math.sqrt(VAR1 / n)
    z = (mean - EXP) / se
    hit3 = sum(1 for m in matches if m >= 3)
    k = max(len(by_round[r]) for r in rounds)
    best = [max(g[2] for g in by_round[r]) for r in rounds]
    rb = _random_best_of(k, 20000, seed=7000 + k)

    def period(last: Optional[int]) -> Dict[str, Any]:
        rs = rounds[-last:] if last else rounds
        m, cnt = _mean_of(by_round, rs)
        if not cnt:
            return {"games": 0}
        s = math.sqrt(VAR1 / cnt)
        return {"rounds": len(rs), "games": cnt, "mean": round(m, 4), "ci95": [round(m - 1.96 * s, 3), round(m + 1.96 * s, 3)],
                "hit3": sum(1 for r in rs for g in by_round[r] if g[2] >= 3)}

    half = len(rounds) // 2
    h1, _ = _mean_of(by_round, rounds[:half]) if half else (None, 0)
    h2, _ = _mean_of(by_round, rounds[half:])
    # 진단 지표
    picks = [g[1] for g in games]
    num_cnt = Counter(x for p in picks for x in p)
    top6_share = sum(c for _x, c in num_cnt.most_common(6)) / max(1, 6 * n)
    first = [min(by_round[r])[1] for r in rounds]  # 회차별 1순위 조합
    repeat = [len(set(a) & set(b)) for a, b in zip(first, first[1:])]
    prev_ov = [len(set(g[1]) & set(prev_of[r])) for r in rounds for g in by_round[r] if prev_of.get(r)]
    st = _structure_rates(picks, int(ref["sum_lo"]), int(ref["sum_hi"]))
    fav = [x for x, _c in num_cnt.most_common(6)]
    fav_rows = []
    for x in fav:
        tot = sum(1 for r in rounds if any(x in g[1] for g in by_round[r]))
        hit = sum(1 for r in rounds if any(x in g[1] for g in by_round[r]) and x in win[r])
        fav_rows.append({"number": x, "picked_rounds": tot, "hit": hit, "hit_rate": round(hit / tot, 3) if tot else None})
    tiers = Counter(g[4] for g in games if g[4])
    problems: List[str] = []
    if top6_share > 0.35:
        problems.append(f"번호 집중: 가장 많이 고른 6개 번호가 전체 선택의 {top6_share:.0%}(무작위 약 13%) — "
                        "같은 번호를 반복해 회차별 결과 변동이 큼(기대 일치 수는 같음)")
    if repeat and sum(repeat) / len(repeat) >= 3.0:
        problems.append(f"고착: 직전 회차 자기 1순위와 평균 {sum(repeat) / len(repeat):.1f}개 겹침 — 최근 결과를 거의 반영하지 않음")
    if prev_ov and len(prev_ov) >= 30:
        po = sum(prev_ov) / len(prev_ov)
        if po > 1.6:
            problems.append(f"직전 당첨번호 과다 반복: 조합당 평균 {po:.2f}개(무작위 0.8)")
        elif po < 0.15:
            problems.append("직전 당첨번호 완전 회피 — 이월 번호가 나오는 회차(약 55%)에서 그 번호를 구조적으로 놓침")
    for key, label in (("sum_out", "합계 95% 범위 밖"), ("odd_extreme", "홀짝 0:6/6:0"), ("consec2", "연속번호 2쌍 이상"),
                       ("decade4", "한 번호대 4개 이상")):
        if st[key] > max(0.12, ref[key] * 2.5):
            problems.append(f"구조 이탈: {label} 조합 {st[key]:.0%}(실제 당첨 {ref[key]:.0%})")
    return {
        "method": method, "label": METHOD_LABELS.get(method, method), "type": ptype,
        "rounds": len(rounds), "first_round": rounds[0], "last_round": rounds[-1], "combos_per_round": k, "games": n,
        "mean_matches": round(mean, 4), "ci95": [round(mean - 1.96 * se, 3), round(mean + 1.96 * se, 3)],
        "z": round(z, 2), "p_below": round(1 - _sf(z), 4), "p_above": round(_sf(z), 4),
        "match_rates": {str(i): round(sum(1 for m in matches if m == i) / n, 4) for i in range(7)},
        "hit3": hit3, "rate_3plus": round(hit3 / n, 4), "expected_hit3": round(P3 * n, 2),
        "prize_counts": {TIER_LABEL[t]: c for t, c in sorted(tiers.items()) if t in TIER_LABEL},
        "best_per_round_mean": round(sum(best) / len(best), 3), "random_best_per_round_mean": round(float(rb.mean()), 3),
        "rounds_best3": sum(1 for b in best if b >= 3), "random_rounds_best3": round(float((rb >= 3).mean()) * len(best), 2),
        "periods": {"last20": period(20), "last50": period(50), "last100": period(100), "all": period(None)},
        "trend": {"first_half_mean": round(h1, 4) if h1 is not None else None, "second_half_mean": round(h2, 4) if h2 is not None else None},
        "diagnostics": {"top6_share": round(top6_share, 3),
                        "self_repeat_mean": round(sum(repeat) / len(repeat), 2) if repeat else None,
                        "prev_draw_overlap_mean": round(sum(prev_ov) / len(prev_ov), 3) if prev_ov else None,
                        "structure_rates": {k2: round(v, 3) for k2, v in st.items()},
                        "favorite_numbers": fav_rows},
        "problems": problems,
    }


def audit(min_rounds: int = 30) -> Dict[str, Any]:
    """전 회차 감사 — 후보군별 성적·하락 판정·원인 진단·자동 보정(투표 제외) 기록."""
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    win = {d.round: set(d.numbers) for d in draws}
    prev_of = {draws[i].round: list(draws[i - 1].numbers) for i in range(1, len(draws))}
    ref = _structure_reference(draws)
    recs = _records()
    methods: List[Dict[str, Any]] = []
    for (t, m), by_round in sorted(recs.items()):
        if m in NOT_AUDITED:
            continue
        by_round = {r: v for r, v in by_round.items() if r in win}
        if by_round:
            methods.append(_method_report(m, t, by_round, win, prev_of, ref))
    testable = [x for x in methods if x["rounds"] >= min_rounds]
    alpha = 0.05 / max(1, len(testable))
    for x in methods:
        if x["rounds"] < min_rounds:
            x["verdict"], x["verdict_label"] = "insufficient", f"표본 부족({x['rounds']}회 < {min_rounds}회) — 판정 보류"
        elif x["p_below"] < alpha:
            x["verdict"], x["verdict_label"] = "below_random", "무작위보다 유의하게 낮음(Bonferroni 보정 후)"
        elif x["p_above"] < alpha:
            x["verdict"], x["verdict_label"] = "above_random", "무작위보다 유의하게 높음(보정 후) — 독립 기간 재현 전까지 우연 가능성"
        elif x["p_below"] < 0.05:
            x["verdict"], x["verdict_label"] = "below_trend", "낮은 경향(보정 전 p<0.05) — 보정 후엔 우연 범위"
        else:
            x["verdict"], x["verdict_label"] = "random_equivalent", "무작위와 구분되지 않음"
        l50 = x["periods"]["last50"]
        x["recent_drop"] = bool(x["rounds"] >= min_rounds and l50.get("games", 0) >= 50 and l50["ci95"][1] < EXP)
    methods.sort(key=lambda x: (x["type"] != "backtest", -x["rounds"], x["mean_matches"]))
    actions = _apply_actions(methods)
    rand = recs.get(("backtest", "random_baseline"), {})
    rand_ms = [g[2] for r, v in rand.items() if r in win for g in v]
    rep = {
        "kind": "round_audit", "latest_round": draws[-1].round if draws else None, "methods": methods,
        "alpha_bonferroni": round(alpha, 5), "n_tested": len(testable), "min_rounds": min_rounds,
        "random_baseline_observed": {"games": len(rand_ms), "mean": round(sum(rand_ms) / len(rand_ms), 4) if rand_ms else None},
        "theory": {"mean_matches": EXP, "rate_3plus": P3, "jackpot_per_combo": "1/8,145,060"},
        "structure_reference": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in ref.items()},
        "summary": {v: sum(1 for x in methods if x["verdict"] == v)
                    for v in ("below_random", "below_trend", "random_equivalent", "above_random", "insufficient")},
        "actions": actions,
        "honesty": ("전 회차 성적은 과거 관측값입니다. 공정 추첨에서 모든 조합의 1등 확률은 1/8,145,060 으로 같고, "
                    "하락 후보군을 빼거나 진단된 구조 문제를 고쳐도 기대 일치 수(0.8)는 바뀌지 않습니다. "
                    "보정은 '보정 후에도 유의하게 낮은' 후보군이 다음 회차 V12 후보에 섞이지 않게 하는 안전장치입니다."),
    }
    from . import reverse_analysis as R

    R._ensure()
    R._save("round_audit", rep["latest_round"], rep)
    return rep


def _apply_actions(methods: List[Dict[str, Any]]) -> Dict[str, Any]:
    """보정 후 유의 하락 또는 최근 50회 95% 상한 < 0.8 → V12 투표 제외. 해소되면 해제."""
    now = db.now_iso()
    flagged = {x["method"]: x for x in methods if x["verdict"] == "below_random" or x.get("recent_drop")}
    active = {r[0]: r[1] for r in db.query("SELECT method, action_id FROM round_audit_actions WHERE active = 1 "
                                            "AND action = 'exclude_from_votes'")}
    added, released = [], []
    with db.transaction() as c:
        for m, x in flagged.items():
            if m in active:
                continue
            reason = (x["verdict_label"] if x["verdict"] == "below_random" else
                      f"최근 50회 평균 {x['periods']['last50']['mean']} (95% 상한 {x['periods']['last50']['ci95'][1]} < 0.8)")
            c.execute("INSERT INTO round_audit_actions (action_id,method,action,reason,metrics_json,active,created_at) "
                      "VALUES (?,?,?,?,?,1,?)", (uuid.uuid4().hex, m, "exclude_from_votes", reason,
                                                db.dumps({k: x[k] for k in ("mean_matches", "z", "p_below", "rounds", "games")}), now))
            added.append({"method": m, "reason": reason})
        for m, aid in active.items():
            if m not in flagged:
                c.execute("UPDATE round_audit_actions SET active = 0, released_at = ? WHERE action_id = ?", (now, aid))
                released.append(m)
    excluded = sorted((set(active) - set(released)) | {a["method"] for a in added})
    return {"excluded_now": excluded, "added": added, "released": released,
            "rule": "보정 후 유의 하락 또는 최근 50회 95% 상한 < 0.8 → 다음 회차 V12 투표에서 제외(원본 엔진·기록 유지, 해소 시 자동 해제)"}


def excluded_methods() -> set:
    try:
        _ensure()
        return {r[0] for r in db.query("SELECT method FROM round_audit_actions WHERE active = 1 AND action = 'exclude_from_votes'")}
    except Exception:  # noqa: BLE001
        return set()


def round_table(limit: int = 60) -> Dict[str, Any]:
    """회차별 후보군 성적표 — 회차마다 후보군별 최고 일치 수(조합 여러 개면 최고)·등수."""
    from ..stats_engine.draws import load_draws
    from .predictions import METHOD_LABELS

    _ensure()
    win = {d.round: d for d in load_draws()}
    recs = _records()
    rounds = sorted({r for v in recs.values() for r in v if r in win}, reverse=True)[: int(limit)]
    rows = []
    for r in rounds:
        cells = {}
        for (t, m), by_round in recs.items():
            if r not in by_round:
                continue
            g = by_round[r]
            best = max(g, key=lambda x: (x[2], x[3]))
            cells[f"{t}:{m}"] = {"best": best[2], "combos": len(g), "tier": best[4], "bonus": bool(best[3])}
        rows.append({"round": r, "winning": sorted(win[r].numbers), "bonus": win[r].bonus, "cells": cells})
    cols = sorted({k for row in rows for k in row["cells"]})
    return {"rounds": rows,
            "columns": [{"key": k, "type": k.split(":", 1)[0], "method": k.split(":", 1)[1],
                         "label": METHOD_LABELS.get(k.split(":", 1)[1], k.split(":", 1)[1]),
                         "coverage": sum(1 for row in rows if k in row["cells"])} for k in cols]}


def last_report() -> Optional[Dict[str, Any]]:
    from . import reverse_analysis as R

    return R.last_report("round_audit")


# ─────────────────────────── 놓친 당첨번호 역추적 · 당첨 패턴 학습(walk-forward) ───────────────────────────

FEATURES = {
    "carry": ("직전 회차 당첨번호(이월)", lambda f: f["carry"]),
    "neighbor": ("직전 당첨번호 ±1(이웃)", lambda f: f["neighbor"] and not f["carry"]),
    "gap_short": ("미출 1~4회", lambda f: 1 <= f["gap"] <= 4),
    "gap_mid": ("미출 5~9회", lambda f: 5 <= f["gap"] <= 9),
    "gap_long": ("미출 10회 이상", lambda f: f["gap"] >= 10),
    "hot20": ("최근 20회 4번 이상 출현", lambda f: f["f20"] >= 4),
    "cold20": ("최근 20회 0~1번 출현", lambda f: f["f20"] <= 1),
    "low": ("1~22 저번호", lambda f: f["n"] <= 22),
    "odd": ("홀수", lambda f: f["n"] % 2 == 1),
}


def _number_features(prior, n: int) -> Dict[str, Any]:
    """대상 회차 이전 데이터(prior)만으로 번호 n 의 특징."""
    prev = set(prior[-1].numbers)
    gap = next((i for i, d in enumerate(reversed(prior)) if n in d.numbers), len(prior))
    return {"n": n, "carry": n in prev, "neighbor": (n - 1 in prev) or (n + 1 in prev), "gap": gap,
            "f20": sum(1 for d in prior[-20:] if n in d.numbers)}


def _z(hit: float, n: float, base: float) -> float:
    return (hit - n * base) / math.sqrt(n * base * (1 - base)) if n and 0 < base < 1 else 0.0


def miss_analysis(window: int = 200) -> Dict[str, Any]:
    """회차마다 당첨번호 6개가 후보(엔진 1순위 + V12 10조합)에 들어갔는지 역추적하고, 놓친 번호의 특징과
    엔진 선택 편향을 비교한다. 당첨 패턴은 '그 회차 이전 데이터'로만 특징을 만들고, 전반/후반 두 기간에서
    모두 보정 후 유의할 때만 학습 신호로 채택한다(우연한 패턴 채택 방지)."""
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    idx = {d.round: i for i, d in enumerate(draws)}
    by_round: Dict[int, Dict[str, List[List[int]]]] = {}
    for (t, m), rr in _records().items():
        if t != "backtest" or m in NOT_AUDITED:
            continue
        for r, games in rr.items():
            by_round.setdefault(r, {})[m] = [g[1] for g in games]
    rounds = sorted(r for r in by_round if r in idx and idx[r] >= 50 and "v12_integrated" in by_round[r])[-int(window):]
    if not rounds:
        return {"kind": "miss_analysis", "rounds": 0, "note": "V12 백테스트가 있는 회차가 없습니다."}
    covered, expected_cov, uniq_sizes, v12_cov, v12_exp = 0, 0.0, [], 0, 0.0
    cnt = {k: {"win": [0, 0], "all": [0, 0], "picked": [0, 0], "missed": 0} for k in FEATURES}
    halves = {k: [[0, 0, 0, 0], [0, 0, 0, 0]] for k in FEATURES}  # [win_hit, win_n, all_hit, all_n]
    per_engine_miss: Dict[str, List[int]] = {}
    examples = []
    for j, r in enumerate(rounds):
        prior = draws[: idx[r]]
        winset = set(draws[idx[r]].numbers)
        preds = by_round[r]
        pool = {n for combos in preds.values() for c in combos for n in c}
        v12pool = {n for c in preds["v12_integrated"] for n in c}
        uniq_sizes.append(len(pool))
        covered += len(winset & pool)
        expected_cov += 6 * len(pool) / 45
        v12_cov += len(winset & v12pool)
        v12_exp += 6 * len(v12pool) / 45
        feats = {n: _number_features(prior, n) for n in range(1, 46)}
        h = 0 if j < len(rounds) // 2 else 1
        for k, (_lab, fn) in FEATURES.items():
            flag = {n: bool(fn(feats[n])) for n in range(1, 46)}
            for n in range(1, 46):
                cnt[k]["all"][0] += flag[n]
                cnt[k]["all"][1] += 1
                halves[k][h][2] += flag[n]
                halves[k][h][3] += 1
                if n in winset:
                    cnt[k]["win"][0] += flag[n]
                    cnt[k]["win"][1] += 1
                    halves[k][h][0] += flag[n]
                    halves[k][h][1] += 1
                    if flag[n] and n not in pool:
                        cnt[k]["missed"] += 1
            for combos in preds.values():
                for c in combos:
                    for n in c:
                        cnt[k]["picked"][0] += flag[n]
                        cnt[k]["picked"][1] += 1
        for m, combos in preds.items():
            got = {n for c in combos for n in c} & winset
            per_engine_miss.setdefault(m, []).append(6 - len(got))
        if j >= len(rounds) - 12:
            missed = sorted(winset - pool)
            examples.append({"round": r, "winning": sorted(winset), "candidate_pool": len(pool), "missed": missed,
                             "missed_features": [{"number": n, "carry": feats[n]["carry"], "gap": feats[n]["gap"],
                                                  "f20": feats[n]["f20"]} for n in missed]})
    n_r = len(rounds)
    alpha = 0.05 / len(FEATURES)
    patterns = []
    for k, (lab, _fn) in FEATURES.items():
        wh, wn = cnt[k]["win"]
        ah, an = cnt[k]["all"]
        ph, pn = cnt[k]["picked"]
        base = ah / an if an else 0
        rate = wh / wn if wn else 0
        z = _z(wh, wn, base)
        p = math.erfc(abs(z) / math.sqrt(2))
        stable = []
        for hv in halves[k]:
            b2 = hv[2] / hv[3] if hv[3] else 0
            z2 = _z(hv[0], hv[1], b2)
            stable.append({"win_rate": round(hv[0] / hv[1], 4) if hv[1] else None, "base": round(b2, 4),
                           "p": round(math.erfc(abs(z2) / math.sqrt(2)), 4), "z": round(z2, 2)})
        adopt = bool(p < alpha and all(s["p"] < alpha and (s["z"] > 0) == (z > 0) for s in stable))
        pick_rate = ph / pn if pn else 0
        bias = pick_rate - rate
        patterns.append({"feature": k, "label": lab, "winning_share": round(rate, 4), "base_share": round(base, 4),
                         "lift": round(rate / base, 3) if base else None, "p": round(p, 4), "halves": stable,
                         "adopted": adopt, "engine_pick_share": round(pick_rate, 4), "engine_bias": round(bias, 4),
                         "missed_winning_numbers": cnt[k]["missed"],
                         "bias_note": (f"엔진 후보가 이 유형을 당첨 실제 비율보다 {abs(bias) * 100:.0f}%p "
                                       f"{'많이' if bias > 0 else '적게'} 고름" if abs(bias) >= 0.05 else None)})
    adopted = [x for x in patterns if x["adopted"]]
    biased = sorted([x for x in patterns if x["bias_note"]], key=lambda x: -abs(x["engine_bias"]))
    eng = [{"method": m, "rounds": len(v), "mean_missed": round(sum(v) / len(v), 3),
            "combos": max(len(by_round[r].get(m, [])) for r in rounds)} for m, v in per_engine_miss.items()]
    eng.sort(key=lambda x: x["mean_missed"])
    rep = {
        "kind": "miss_analysis", "rounds": n_r, "from": rounds[0], "to": rounds[-1],
        "coverage": {"candidate_pool_mean": round(sum(uniq_sizes) / n_r, 1),
                     "winning_in_pool_per_round": round(covered / n_r, 3),
                     "expected_if_random_same_size": round(expected_cov / n_r, 3),
                     "v12_winning_in_pool_per_round": round(v12_cov / n_r, 3),
                     "v12_expected_if_random_same_size": round(v12_exp / n_r, 3)},
        "why_missed": [
            f"후보 풀(엔진 1순위 + V12 10조합)은 회차당 평균 {sum(uniq_sizes) / n_r:.1f}개 번호 — 당첨 6개 중 평균 "
            f"{covered / n_r:.2f}개가 풀 안에 있었고, 같은 크기 무작위 풀의 기대값은 {expected_cov / n_r:.2f}개입니다.",
            "놓친 당첨번호의 특징(이월·미출 기간·최근 빈도)을 전체 번호 기준 비율과 비교했습니다(아래 표). "
            "기준 비율과 같다면 엔진이 특정 유형을 체계적으로 놓친 것이 아니라 45개 중 6개를 맞혀야 하는 구조 때문입니다.",
        ] + [f"편향: {x['label']} — {x['bias_note']} (당첨 실제 {x['winning_share'] * 100:.0f}%)" for x in biased[:4]],
        "patterns": patterns, "adopted_patterns": [x["feature"] for x in adopted],
        "alpha_bonferroni": round(alpha, 4), "engines_by_missed": eng, "recent_examples": list(reversed(examples)),
        "verdict": (f"전반·후반 두 기간 모두에서 보정 후 유의한 당첨 패턴 {len(adopted)}개를 학습 신호로 채택: "
                    + ", ".join(x["label"] for x in adopted) + " — V12 번호 점수에 반영" if adopted else
                    "두 기간 모두에서 재현되는 당첨 패턴이 없습니다 — 당첨번호 특징은 무작위 기준 비율과 같아, "
                    "패턴을 학습해 넣어도 적중이 오르지 않습니다. 대신 엔진 선택 편향을 줄이도록 V12 조합 다양성을 보정했습니다."),
        "honesty": "역추적·패턴 학습은 과거 관측입니다. 공정 추첨에서 1등 확률은 조합마다 1/8,145,060 으로 같습니다.",
    }
    from . import reverse_analysis as R

    R._ensure()
    R._save("miss_analysis", rounds[-1], rep)
    return rep


def adopted_pattern_bonus(prior) -> Dict[int, float]:
    """채택된 당첨 패턴(두 기간 재현)만 V12 번호 점수 보너스로 — 없으면 빈 dict(보정 없음)."""
    from . import reverse_analysis as R

    rep = R.last_report("miss_analysis") or {}
    keys = [k for k in rep.get("adopted_patterns", []) if k in FEATURES]
    if not keys or not prior:
        return {}
    lift = {x["feature"]: x["lift"] for x in rep.get("patterns", []) if x["feature"] in keys}
    out: Dict[int, float] = {}
    for n in range(1, 46):
        f = _number_features(prior, n)
        for k in keys:
            if FEATURES[k][1](f):
                out[n] = out.get(n, 0.0) + 0.05 * (1 if (lift.get(k) or 1) > 1 else -1)
    return out


# ─────────────────────────── 중복 추천 번호: 잡은 회차 vs 못 잡은 회차 비교 · 규칙 학습 · 엔진별 약점 ───────────────────────────

P0 = 6 / 45


def _cond_keys(f: Dict[str, Any], k: Optional[int] = None) -> List[str]:
    """번호 한 개의 그 회차 직전 상태 → 조건 키 목록."""
    keys = [f"gap:{_gap_label(f['gap'])}", f"f20:{'hot' if f['f20'] >= 4 else 'cold' if f['f20'] <= 1 else 'mid'}"]
    if f["carry"]:
        keys.append("carry")
    if f["neighbor"] and not f["carry"]:
        keys.append("neighbor")
    if k is not None:
        keys.append(f"engines:{min(k, 5)}{'+' if k >= 5 else ''}")
    return keys


def _gap_label(g: int) -> str:
    return "0" if g <= 0 else "1-4" if g <= 4 else "5-9" if g <= 9 else "10+"


COND_LABEL = {"gap:0": "직전 회차 당첨(이월)", "gap:1-4": "미출 1~4회", "gap:5-9": "미출 5~9회", "gap:10+": "미출 10회 이상",
              "f20:hot": "최근 20회 4번 이상", "f20:mid": "최근 20회 2~3번", "f20:cold": "최근 20회 0~1번",
              "carry": "이월 번호", "neighbor": "직전 당첨 ±1"}


def _rate_row(key: str, h: List[List[int]], alpha: float) -> Dict[str, Any]:
    """h = [[hit, n] 전반, [hit, n] 후반] → 전체·기간별 적중률, 무작위 13.3% 대비 p, 두 기간 재현 여부."""
    hit = h[0][0] + h[1][0]
    n = h[0][1] + h[1][1]
    rate = hit / n if n else 0.0
    z = _z(hit, n, P0)
    halves = []
    for hh, nn in h:
        z2 = _z(hh, nn, P0)
        halves.append({"n": nn, "rate": round(hh / nn, 4) if nn else None, "p": round(math.erfc(abs(z2) / math.sqrt(2)), 4), "z": round(z2, 2)})
    p = math.erfc(abs(z) / math.sqrt(2))
    replicated = bool(n >= 200 and p < alpha and all(x["n"] >= 80 and x["p"] < alpha and (x["z"] > 0) == (z > 0) for x in halves))
    return {"condition": key, "label": COND_LABEL.get(key, key.replace("engines:", "엔진 ") + "개 동시 추천"),
            "picks": n, "hits": hit, "hit_rate": round(rate, 4), "lift": round(rate / P0, 3), "p": round(p, 4),
            "halves": halves, "replicated": replicated,
            "direction": "better" if z > 0 else "worse"}


def consensus_learning(window: int = 300) -> Dict[str, Any]:
    """① 여러 엔진이 같이 고른 번호가 '잡힌 회차'와 '못 잡힌 회차'를 비교(그 회차 직전 상태: 미출·빈도·이월·동시 추천 수)
    ② 조건별 적중률이 두 기간 모두에서 보정 후 무작위(13.3%)와 다를 때만 규칙으로 채택 → V12 점수에 반영
    ③ 엔진별로 '그 엔진이 고른 번호'의 조건별 적중률을 보고, 두 기간 모두 낮은 조건을 그 엔진의 약점으로 진단
       → 약점 조건에 해당하는 그 엔진의 추천은 V12 투표에서 감쇠(엔진 원본·기록은 그대로)."""
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    idx = {d.round: i for i, d in enumerate(draws)}
    by_round: Dict[int, Dict[str, List[int]]] = {}
    for (t, m), rr in _records().items():
        if t != "backtest" or m in NOT_AUDITED or m.startswith("v12"):
            continue
        for r, games in rr.items():
            g1 = min(games)  # 1순위 조합
            by_round.setdefault(r, {})[m] = g1[1]
    rounds = sorted(r for r in by_round if r in idx and idx[r] >= 50 and len(by_round[r]) >= 2)[-int(window):]
    if len(rounds) < 40:
        return {"kind": "consensus_learning", "rounds": len(rounds), "note": "비교할 회차가 부족합니다."}
    half_of = {r: (0 if i < len(rounds) // 2 else 1) for i, r in enumerate(rounds)}
    cond: Dict[str, List[List[int]]] = {}
    eng: Dict[str, Dict[str, List[List[int]]]] = {}
    caught, missed = [], []
    for r in rounds:
        prior = draws[: idx[r]]
        win = set(draws[idx[r]].numbers)
        preds = by_round[r]
        cnt = Counter(n for nums in preds.values() for n in nums)
        h = half_of[r]
        feats: Dict[int, Dict[str, Any]] = {}
        for n, k in cnt.items():
            feats[n] = _number_features(prior, n)
            if k < 2:
                continue
            for key in _cond_keys(feats[n], k):
                c = cond.setdefault(key, [[0, 0], [0, 0]])
                c[h][0] += n in win
                c[h][1] += 1
        for m, nums in preds.items():
            for n in nums:
                for key in _cond_keys(feats[n]):
                    c = eng.setdefault(m, {}).setdefault(key, [[0, 0], [0, 0]])
                    c[h][0] += n in win
                    c[h][1] += 1
        mx = max(cnt.values())
        tops = [n for n, k in cnt.items() if k >= 3 or (k == mx and k >= 2)]
        hit = [n for n in tops if n in win]
        row = {"round": r, "top": sorted(tops), "hit": sorted(hit), "winning": sorted(win), "max_engines": mx,
               "top_gap_mean": round(sum(feats[n]["gap"] for n in tops) / len(tops), 2) if tops else None,
               "top_carry": sum(1 for n in tops if feats[n]["carry"]),
               "winning_gap_mean": round(sum(_number_features(prior, n)["gap"] for n in win) / 6, 2),
               "winning_carry": sum(1 for n in win if n in set(prior[-1].numbers))}
        (caught if len(hit) >= 2 else missed if not hit else []).append(row)

    def avg(rows, k):
        v = [x[k] for x in rows if x[k] is not None]
        return round(sum(v) / len(v), 3) if v else None

    alpha = 0.05 / max(1, len(cond))
    rules = sorted((_rate_row(k, v, alpha) for k, v in cond.items()), key=lambda x: -x["picks"])
    adopted = [x for x in rules if x["replicated"]]
    weak: Dict[str, List[Dict[str, Any]]] = {}
    strong: Dict[str, List[Dict[str, Any]]] = {}
    n_eng_tests = sum(len(v) for v in eng.values())
    alpha_e = 0.05 / max(1, n_eng_tests)
    engine_rows = []
    for m, cs in eng.items():
        rows = [_rate_row(k, v, alpha_e) for k, v in cs.items()]
        tot_h = sum(v[0][0] + v[1][0] for k, v in cs.items() if k.startswith("gap:"))
        tot_n = sum(v[0][1] + v[1][1] for k, v in cs.items() if k.startswith("gap:"))
        w = [x for x in rows if x["replicated"] and x["direction"] == "worse"]
        s_ = [x for x in rows if x["replicated"] and x["direction"] == "better"]
        if w:
            weak[m] = w
        if s_:
            strong[m] = s_
        worst = min((x for x in rows if x["picks"] >= 100), key=lambda x: x["hit_rate"], default=None)
        engine_rows.append({"method": m, "picks": tot_n, "hit_rate": round(tot_h / tot_n, 4) if tot_n else None,
                            "weak_conditions": [x["condition"] for x in w], "strong_conditions": [x["condition"] for x in s_],
                            "lowest_condition": ({"condition": worst["condition"], "label": worst["label"], "hit_rate": worst["hit_rate"],
                                                  "picks": worst["picks"], "p": worst["p"]} if worst else None),
                            "conditions": rows})
    engine_rows.sort(key=lambda x: (x["hit_rate"] or 0))
    rep = {
        "kind": "consensus_learning", "rounds": len(rounds), "from": rounds[0], "to": rounds[-1],
        "random_rate": round(P0, 4), "alpha_bonferroni": round(alpha, 5),
        "caught_vs_missed": {
            "caught_rounds": len(caught), "missed_rounds": len(missed),
            "caught": {"top_gap_mean": avg(caught, "top_gap_mean"), "top_carry": avg(caught, "top_carry"),
                       "max_engines": avg(caught, "max_engines"), "winning_gap_mean": avg(caught, "winning_gap_mean"),
                       "winning_carry": avg(caught, "winning_carry")},
            "missed": {"top_gap_mean": avg(missed, "top_gap_mean"), "top_carry": avg(missed, "top_carry"),
                       "max_engines": avg(missed, "max_engines"), "winning_gap_mean": avg(missed, "winning_gap_mean"),
                       "winning_carry": avg(missed, "winning_carry")},
            "recent_caught": list(reversed(caught[-6:])), "recent_missed": list(reversed(missed[-6:])),
        },
        "rules": rules, "adopted_rules": [x["condition"] for x in adopted],
        "engines": engine_rows,
        "engine_weak": {m: [x["condition"] for x in v] for m, v in weak.items()},
        "engine_strong": {m: [x["condition"] for x in v] for m, v in strong.items()},
        "verdict": ("두 기간 모두 재현된 규칙 " + ", ".join(x["label"] for x in adopted) + " — V12 점수에 반영" if adopted else
                    "잡은 회차와 못 잡은 회차를 비교해도 두 기간 모두 재현되는 규칙이 없습니다 — 잡은 회차는 우연(무작위 13.3% 범위)으로 설명됩니다.")
                   + (" · 엔진 약점(두 기간 재현): " + "; ".join(f"{m}: {', '.join(COND_LABEL.get(c, c) for c in v)}" for m, v in
                                                     {m: [x["condition"] for x in w] for m, w in weak.items()}.items())
                      + " → 해당 조건의 추천은 V12 투표에서 감쇠" if weak else " · 두 기간 모두 재현되는 엔진별 약점 조건도 없습니다."),
        "honesty": "규칙·약점은 과거 백테스트 관측이며 두 기간 재현 + Bonferroni 보정을 통과할 때만 반영합니다. 1등 확률은 조합마다 1/8,145,060 으로 같습니다.",
    }
    from . import reverse_analysis as R

    R._ensure()
    R._save("consensus_learning", rounds[-1], rep)
    return rep


def consensus_adjustments(prior) -> Tuple[Dict[int, float], Dict[str, List[str]]]:
    """채택된 규칙 → 번호 보너스, 엔진 약점 → (엔진, 조건) 감쇠 목록. 없으면 빈 값(보정 없음)."""
    from . import reverse_analysis as R

    rep = R.last_report("consensus_learning") or {}
    rules = {x["condition"]: x for x in rep.get("rules", []) if x.get("replicated") and not x["condition"].startswith("engines:")}
    bonus: Dict[int, float] = {}
    if rules and prior:
        for n in range(1, 46):
            for key in _cond_keys(_number_features(prior, n)):
                if key in rules:
                    bonus[n] = bonus.get(n, 0.0) + (0.05 if rules[key]["direction"] == "better" else -0.05)
    return bonus, dict(rep.get("engine_weak") or {})
