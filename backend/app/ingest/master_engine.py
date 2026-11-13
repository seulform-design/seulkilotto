"""통합 마스터 엔진 — V8 누수 차단 · V9 엔진 신뢰도 · V10 번호 편향 · V11 무작위 시뮬레이션 · V12 현재 회차 후보.

원칙(V5~V7 과 동일)
- 기존 예측·모델·데이터는 지우거나 바꾸지 않는다. V12 는 '새 방식(v12_integrated)'으로 추가 저장만 한다.
- 모든 평가는 그 회차 이전에 만들어진 예측/데이터만 쓴다(V8 이 검사하고, 위반 행은 격리 후 집계에서 제외).
- 번호 평가 점수·조합 평가 점수는 '설명용 지표'다. 가중치는 사전에 고정(WEIGHTS_VERSION)하고 결과를 보고 조정하지 않는다.
- 공정·독립 추첨에서 모든 6개 조합의 1등 확률은 1/8,145,060 으로 같다. 점수가 높다고 당첨 확률이 오르지 않는다.
"""
from __future__ import annotations

import math
import random
from collections import Counter
from itertools import combinations
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import db
from . import reverse_analysis as R

EXP = 0.8
VAR1 = R.VAR1
PERIODS = (("last20", 20), ("last50", 50), ("last100", 100), ("all", None))
WEIGHTS_VERSION = "v12-w2"
# w2(2026-11-13): 회차별 성적 감사에서 w1 10조합이 같은 번호를 많이 공유(상위 6개 번호 비중 42%)해 200회 중
# '10조합 중 하나라도 3개 이상'인 회차가 34회로, 서로 독립인 무작위 10조합 기대치(41.9회)보다 적었다.
# 기대 일치 수(0.8)는 조합 구성과 무관하지만, 조합끼리 겹칠수록 같이 맞고 같이 틀려 '회차당 하나라도 맞을 확률'이
# 줄어든다(수학적 성질 — 결과를 보고 고른 조정이 아님). → 10조합 전체에서 번호 사용 ≤2회, 모든 조합 쌍 겹침 ≤2.
MAX_NUMBER_USE = 2
MAX_PAIR_OVERLAP = 2
WEIGHTS = {"long": 0.15, "mid": 0.15, "recent": 0.15, "gap": 0.10, "votes": 0.20, "validated_votes": 0.10,
           "stability": 0.10, "bias_penalty": 0.05}
TIER_LABEL = {1: "1등", 2: "2등", 3: "3등", 4: "4등", 5: "5등"}
EXCLUDE_VOTES = {"random_baseline", "v12_integrated"}


def _sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2))


def _rows(ptype: Optional[str] = None) -> List[tuple]:
    R._ensure()
    q = R._quarantined()
    sql = ("SELECT h.prediction_id, h.prediction_method, h.prediction_type, h.draw_round, h.prediction_rank, "
           "h.predicted_numbers, e.match_count, e.bonus_matched, e.prize_tier FROM round_prediction_history h "
           "JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id")
    rows = db.query(sql + " WHERE h.prediction_status <> 'superseded'" + (" AND h.prediction_type = ?" if ptype else ""), (ptype,) if ptype else ())
    return [r for r in rows if r[0] not in q]


# ─────────────────────────────── 1. 전체 엔진 진단 ───────────────────────────────

def diagnose_engines() -> Dict[str, Any]:
    R._ensure()
    preds = db.query("SELECT prediction_type, prediction_method, COUNT(*), MIN(draw_round), MAX(draw_round) "
                     "FROM round_prediction_history GROUP BY prediction_type, prediction_method")
    try:
        eng = db.query("SELECT engine, category, status, last_round, last_run_at FROM reg_engines")
    except Exception:  # noqa: BLE001
        eng = []
    from . import predictions as P

    return {
        "prediction_methods": [{"type": t, "method": m, "label": P.METHOD_LABELS.get(m, m), "rows": n, "first": a, "last": b}
                               for t, m, n, a, b in sorted(preds)],
        "learning_engines": [{"engine": e, "category": c, "status": s, "last_round": lr, "last_run_at": la}
                             for e, c, s, lr, la in eng],
        "modules": {"V1~V4-A": "보관(유튜브 확정) 용지 학습 — 표본 수에 따라 판정", "V5": "역분석", "V6": "보정 후보(홀드아웃 승인)",
                    "V7": "자기개선 루프", "V8": "누수 차단", "V9": "엔진 신뢰도", "V10": "번호 편향",
                    "V11": "무작위 시뮬레이션", "V12": "현재 회차 후보"},
        "data_preserved": "기존 예측·평가·모델 행은 삭제/수정하지 않음",
    }


# ─────────────────────────────── V8 사후 백테스트·누수 차단 ───────────────────────────────

def v8_leakage(sample: int = 60) -> Dict[str, Any]:
    """① 저장 메타(생성 시점·cutoff·학습 종료 회차·모델 버전) 검사 → 위반 격리
    ② 재현 검사: 저장된 회차통계 백테스트를 '그 회차 이전 데이터만'으로 다시 계산해 같은지 확인
    ③ 사전 예측(live)·백테스트·사후 재현(historical_replay)을 분리 집계."""
    from ..stats_engine.backtest import _rankings
    from ..stats_engine.draws import load_draws

    inv = R.inventory()  # ① (격리 기록 포함)
    rows = db.query("SELECT prediction_type, COUNT(*), SUM(CASE WHEN engine_version IS NULL OR engine_version = '' THEN 1 ELSE 0 END) "
                    "FROM round_prediction_history GROUP BY prediction_type")
    split = {t: {"rows": int(n), "missing_engine_version": int(mv or 0)} for t, n, mv in rows}
    draws = load_draws()
    idx_of = {d.round: i for i, d in enumerate(draws)}
    stored = db.query("SELECT draw_round, prediction_method, predicted_numbers FROM round_prediction_history "
                      "WHERE prediction_type = 'backtest' AND prediction_rank = 1 AND prediction_method IN "
                      "('stats_hot','stats_cold','stats_overdue','stats_recent','stats_pair_hot','stats_last_avoid')")
    rng = random.Random(8)
    pick = rng.sample(stored, min(sample, len(stored))) if stored else []
    want: Dict[int, List[Tuple[str, List[int]]]] = {}
    for r, m, nums in pick:
        if int(r) in idx_of:
            want.setdefault(idx_of[int(r)], []).append((m, sorted(db.loads(nums))))
    checked = mismatched = 0
    examples = []
    if want:
        for idx, st in R._walk(draws):
            if idx > max(want):
                break
            if idx in want:
                ranks = _rankings(st.freq, st.last_seen, st.pair, st.prev, idx)
                for m, nums in want[idx]:
                    checked += 1
                    if sorted(ranks[m.replace("stats_", "")][:6]) != nums:
                        mismatched += 1
                        if len(examples) < 5:
                            examples.append({"round": draws[idx].round, "method": m})
    status = "ok" if inv["quarantine"]["total"] == 0 and mismatched == 0 else "issues_found"
    rep = {"kind": "v8", "status": status, "quarantine": inv["quarantine"], "by_type": split,
           "replay_check": {"checked": checked, "mismatched": mismatched, "examples": examples,
                            "method": "저장된 백테스트 번호 = 그 회차 이전 공식 결과만으로 재계산한 번호인지 비교"},
           "separation": {"live": "사전 예측(cutoff 이전 생성분만 유효)", "backtest": "walk-forward 재현(학습 종료 < 대상 회차)",
                          "historical_replay": "사후 재현 — 실시간 성과로 집계하지 않음"},
           "checks": ["생성 시점 < 추첨 cutoff(live)", "학습 데이터 종료 회차 < 대상 회차(backtest)", "번호 형식(6개·중복 없음·1~45)",
                      "엔진 버전 기록", "재계산 일치(회차통계)"]}
    R._save("v8", draws[-1].round if draws else None, rep)
    return rep


# ─────────────────────────────── V9 엔진 신뢰도 ───────────────────────────────

def _period_stats(matches: List[int], bonus: List[int], tiers: List[Optional[int]]) -> Dict[str, Any]:
    n = len(matches)
    if not n:
        return {"rounds": 0}
    mean = sum(matches) / n
    se = math.sqrt(VAR1 / n)
    z = (mean - EXP) / se
    return {"rounds": n, "mean": round(mean, 4), "ci95": [round(mean - 1.96 * se, 3), round(mean + 1.96 * se, 3)],
            "z": round(z, 2), "p_above": round(_sf(z), 4), "hit3": sum(1 for m in matches if m >= 3),
            "hit4": sum(1 for m in matches if m >= 4), "hit5": sum(1 for m in matches if m >= 5),
            "tiers": {TIER_LABEL[t]: c for t, c in sorted(Counter(t for t in tiers if t).items()) if t in TIER_LABEL}}


def _series() -> Dict[Tuple[str, str], Dict[int, Tuple[List[int], int, int, Optional[int]]]]:
    out: Dict[Tuple[str, str], Dict[int, Tuple[List[int], int, int, Optional[int]]]] = {}
    for _pid, m, t, r, rank, nums, mc, bm, tier in _rows():
        if int(rank) != 1:
            continue
        out.setdefault((t, m), {})[int(r)] = (sorted(int(x) for x in db.loads(nums)), int(mc), int(bm), tier)
    return out


def v9_reliability() -> Dict[str, Any]:
    ser = _series()
    latest = max((max(v) for v in ser.values() if v), default=0)
    n_methods = max(1, sum(1 for (t, m) in ser if t == "backtest" and m != "random_baseline"))
    alpha = 0.05 / n_methods
    by_round_combo: Dict[Tuple[str, int], Dict[str, Tuple[int, ...]]] = {}
    for (t, m), recs in ser.items():
        for r, (nums, *_x) in recs.items():
            by_round_combo.setdefault((t, r), {})[m] = tuple(nums)
    out = []
    for (t, m), recs in sorted(ser.items()):
        rs = sorted(recs)
        per = {}
        for name, w in PERIODS:
            sub = [r for r in rs if (w is None or r > latest - w)]
            per[name] = _period_stats([recs[r][1] for r in sub], [recs[r][2] for r in sub], [recs[r][3] for r in sub])
        ms = [recs[r][1] for r in rs]
        roll = [sum(ms[i:i + 20]) / 20 for i in range(0, max(0, len(ms) - 19))]
        vol = round(float(np.std(roll)), 4) if len(roll) > 1 else None
        half = len(ms) // 2
        ts = None
        if half >= 20:
            a, b = ms[:half], ms[half:]
            zt = (sum(b) / len(b) - sum(a) / len(a)) / math.sqrt(VAR1 / len(a) + VAR1 / len(b))
            ts = {"first_half": round(sum(a) / len(a), 4), "second_half": round(sum(b) / len(b), 4), "z": round(zt, 2),
                  "p": round(2 * _sf(abs(zt)), 4)}
        dup = sum(1 for r in rs if sum(1 for mm, c in by_round_combo[(t, r)].items() if mm != m and c == tuple(recs[r][0])) > 0)
        rep_prev = sum(1 for a, b in zip(rs, rs[1:]) if recs[a][0] == recs[b][0])
        allp = per["all"]
        if allp["rounds"] < 30:
            grade = "표본 부족(30회 미만)"
        elif allp["p_above"] < alpha:
            grade = "무작위보다 유의하게 높음(독립 재현 필요)"
        elif _sf(-allp["z"]) < alpha:
            grade = "무작위보다 유의하게 낮음"
        else:
            grade = "무작위와 구분 안 됨"
        out.append({"type": t, "method": m, "periods": per, "volatility_rolling20": vol,
                    "volatility_expected": round(math.sqrt(VAR1 / 20), 4), "time_split": ts, "grade": grade,
                    "duplicate_with_other_engine_rate": round(dup / len(rs), 4) if rs else None,
                    "same_as_previous_round_rate": round(rep_prev / max(1, len(rs) - 1), 4)})
    out.sort(key=lambda x: (x["type"], -(x["periods"]["all"].get("mean") or 0)))
    rep = {"kind": "v9", "latest_round": latest, "bonferroni_alpha": round(alpha, 5), "methods": out,
           "random_expected": {"mean": EXP, "volatility_rolling20": round(math.sqrt(VAR1 / 20), 4)}}
    R._save("v9", latest, rep)
    return rep


# ─────────────────────────────── V10 번호 편향 ───────────────────────────────

def v10_number_bias() -> Dict[str, Any]:
    from . import engine_audit as A
    from ..stats_engine.draws import load_draws

    ser = {m: v for (t, m), v in _series().items() if t == "backtest" and m not in EXCLUDE_VOTES}
    win = {d.round: set(d.numbers) for d in load_draws()}
    rec = [0] * 46
    hit = [0] * 46
    per_engine: Dict[str, List[int]] = {}
    total_preds = 0
    for m, recs in ser.items():
        vec = [0] * 46
        for r, (nums, *_x) in recs.items():
            total_preds += 1
            for n in nums:
                rec[n] += 1
                vec[n] += 1
                if n in win.get(r, ()):
                    hit[n] += 1
        per_engine[m] = vec
    exp_rec = total_preds * 6 / 45
    p_num = 6 / 45
    alpha = 0.05 / 45
    numbers = []
    for n in range(1, 46):
        k = rec[n]
        hr = hit[n] / k if k else None
        z = (hit[n] - k * p_num) / math.sqrt(k * p_num * (1 - p_num)) if k else 0.0
        numbers.append({"number": n, "recommended": k, "share_vs_expected": round(k / exp_rec, 3) if exp_rec else None,
                        "hits_when_recommended": hit[n], "hit_rate": round(hr, 4) if hr is not None else None,
                        "z_vs_6_45": round(z, 2), "significant_bonferroni": k > 0 and 2 * _sf(abs(z)) < alpha})
    methods = sorted(per_engine)
    corr = []
    for a, b in combinations(methods, 2):
        x, y = np.array(per_engine[a][1:], float), np.array(per_engine[b][1:], float)
        c = float(np.corrcoef(x, y)[0, 1]) if x.std() and y.std() else 0.0
        corr.append({"a": a, "b": b, "corr": round(c, 3)})
    corr.sort(key=lambda p: -abs(p["corr"]))
    data3 = {m: {r: (v[0], v[1], v[2]) for r, v in recs.items()} for m, recs in ser.items()}
    rounds = sorted({r for v in data3.values() for r in v})
    ind = A.independence(data3, rounds) if data3 else {}
    over = sorted(numbers, key=lambda x: -(x["share_vs_expected"] or 0))[:5]
    rep = {"kind": "v10", "numbers": numbers, "predictions": total_preds, "expected_recommendations_per_number": round(exp_rec, 1),
           "most_over_recommended": [x["number"] for x in over], "recommendation_correlation_top": corr[:10],
           "engine_overlap": {k: ind.get(k) for k in ("effective_independent_engines", "engines", "random_jaccard_expected")}
           | {"top_pairs": (ind.get("pairs") or [])[:5]},
           "any_number_hit_rate_significant": any(x["significant_bonferroni"] for x in numbers),
           "note": "추천이 몰린 번호는 엔진 간 공통 계산식(누적 빈도 등) 때문 — 실제 적중률은 번호별로 6/45 와 비교."}
    R._save("v10", max(rounds) if rounds else None, rep)
    return rep


# ─────────────────────────────── V11 무작위 시뮬레이션 ───────────────────────────────

def _random_portfolio(n_games: int, sims: int, seed: int) -> Tuple[np.ndarray, np.ndarray]:
    """같은 게임 수(회차×조합)의 무작위 구매 — 게임당 일치 수 ~ 초기하(6, 39, 6). (평균, 3+ 개수) 분포."""
    g = np.random.default_rng(seed)
    m = g.hypergeometric(6, 39, 6, size=(sims, n_games))
    return m.mean(axis=1), (m >= 3).sum(axis=1)


def v11_random_sim(sims: int = 5000) -> Dict[str, Any]:
    by: Dict[Tuple[str, str], List[int]] = {}
    combos: Dict[Tuple[str, str], Counter] = {}
    for _pid, m, t, r, rank, _nums, mc, _bm, _tier in _rows():
        by.setdefault((t, m), []).append(int(mc))
        combos.setdefault((t, m), Counter())[int(r)] += 1
    out = []
    for i, ((t, m), ms) in enumerate(sorted(by.items())):
        if len(ms) < 5:
            continue
        means, h3 = _random_portfolio(len(ms), sims, seed=11_000 + i)
        mean = sum(ms) / len(ms)
        k3 = sum(1 for x in ms if x >= 3)
        out.append({"type": t, "method": m, "games": len(ms), "rounds": len(combos[(t, m)]),
                    "combos_per_round": round(len(ms) / len(combos[(t, m)]), 2), "engine_mean": round(mean, 4),
                    "random_mean_p50": round(float(np.median(means)), 4),
                    "random_mean_ci95": [round(float(np.quantile(means, 0.025)), 4), round(float(np.quantile(means, 0.975)), 4)],
                    "percentile_vs_random": round(float((means < mean).mean() + 0.5 * (means == mean).mean()), 3),
                    "p_engine_ge_random": round(float((means >= mean).mean()), 4), "engine_hit3": k3,
                    "random_hit3_p50": int(np.median(h3)), "p_hit3_ge": round(float((h3 >= k3).mean()), 4)})
    rep = {"kind": "v11", "simulations": sims, "methods": out,
           "note": "엔진과 같은 게임 수·같은 조합 수(회차당)로 무작위 구매를 반복 — 백분위 50%면 무작위와 같은 수준."}
    R._save("v11", None, rep)
    return rep


# ─────────────────────────────── V12 현재 회차 후보 ───────────────────────────────

def _norm(v: Sequence[float]) -> List[float]:
    vals = list(v[1:])
    lo, hi = min(vals), max(vals)
    return [0.0] + [((x - lo) / (hi - lo) if hi > lo else 0.5) for x in vals]


def number_scores(draws, votes: Dict[int, float], validated: Dict[int, float]) -> List[Dict[str, Any]]:
    """1~45 번호 평가 — draws 는 모두 대상 회차 이전, votes 는 대상 회차용(이전 데이터로 만든) 엔진 추천."""
    n = len(draws)
    long_ = [0] * 46
    mid = [0] * 46
    rec = [0] * 46
    last = [0] * 46
    for i, d in enumerate(draws):
        for x in d.numbers:
            long_[x] += 1
            last[x] = i + 1
            if i >= n - 100:
                mid[x] += 1
            if i >= n - 20:
                rec[x] += 1
    gap = [0] + [n - last[x] for x in range(1, 46)]
    stab = [0.0] + [abs(rec[x] / 20 - long_[x] / max(1, n)) for x in range(1, 46)]
    comp = {"long": _norm(long_), "mid": _norm(mid), "recent": _norm(rec), "gap": _norm(gap),
            "votes": _norm([0] + [votes.get(x, 0) for x in range(1, 46)]),
            "validated_votes": _norm([0] + [validated.get(x, 0) for x in range(1, 46)]),
            "stability": [0.0] + [1 - v for v in _norm(stab)[1:]],
            "bias_penalty": _norm([0] + [votes.get(x, 0) for x in range(1, 46)])}
    out = []
    wsum = sum(v for k, v in WEIGHTS.items() if k != "bias_penalty")
    for x in range(1, 46):
        s = sum(WEIGHTS[k] * comp[k][x] for k in WEIGHTS if k != "bias_penalty") - WEIGHTS["bias_penalty"] * comp["bias_penalty"][x]
        out.append({"number": x, "score": round(s / wsum, 4), "freq_all": long_[x], "freq_100": mid[x], "freq_20": rec[x],
                    "gap": gap[x], "engine_votes": round(votes.get(x, 0), 2), "validated_votes": round(validated.get(x, 0), 3),
                    "components": {k: round(comp[k][x], 3) for k in comp}})
    out.sort(key=lambda r: (-r["score"], r["number"]))
    for i, r in enumerate(out, start=1):
        r["rank"] = i
        r["tier"] = "A" if i <= 10 else "B" if i <= 20 else "C" if i <= 30 else "-"
    return out


def structure(c: Sequence[int], sum_range: Tuple[int, int]) -> Dict[str, Any]:
    s = sorted(c)
    f = R.features_of(s)
    gaps = [b - a for a, b in zip(s, s[1:])]
    checks = {"odd_2_4": 2 <= f["odd"] <= 4, "low_2_4": 2 <= f["low"] <= 4, "sum_range": sum_range[0] <= f["sum"] <= sum_range[1],
              "max_gap_le_20": max(gaps) <= 20, "consec_le_1": f["consec"] <= 1, "last_digits_ge_4": f["last_digits"] >= 4,
              "decade_le_2": f["max_decade"] <= 2}
    return {"checks": checks, "pass_rate": round(sum(checks.values()) / len(checks), 3), "odd": f["odd"], "low": f["low"],
            "sum": f["sum"], "consec": f["consec"], "last_digits": f["last_digits"], "max_decade": f["max_decade"], "max_gap": max(gaps)}


def generate_combos(scores: List[Dict[str, Any]], seed: int, sample_n: int = 6000) -> List[Dict[str, Any]]:
    """핵심 1~3(A만) · 분산 4~7(A+B, 겹침≤2) · 실험 8~10(C 2개 이상). 조합 점수 = 0.6×번호 점수 평균 + 0.4×구조 통과율."""
    sc = {r["number"]: r["score"] for r in scores}
    tier = {r["number"]: r["tier"] for r in scores}
    A = [r["number"] for r in scores if r["tier"] == "A"]
    B = [r["number"] for r in scores if r["tier"] == "B"]
    C = [r["number"] for r in scores if r["tier"] == "C"]
    ref = R.reference()
    rng = random.Random(seed)
    sum_range = (int(ref["sum_range95"][0]) + 15, int(ref["sum_range95"][1]) - 15)

    def evaluate(c):
        st = structure(c, sum_range)
        ns = sum(sc[x] for x in c) / 6
        return round(0.6 * ns + 0.4 * st["pass_rate"], 4), ns, st

    def pool(cands):
        out = []
        for c in cands:
            tot, ns, st = evaluate(c)
            out.append((tot, tuple(sorted(c)), ns, st))
        out.sort(key=lambda x: (-x[0], x[1]))
        return out

    chosen: List[Dict[str, Any]] = []

    def take(pl, k, group, max_overlap, max_use=MAX_NUMBER_USE):
        for tot, c, ns, st in pl:
            if len([x for x in chosen if x["group"] == group]) >= k:
                return
            if any(len(set(c) & set(x["numbers"])) > max_overlap for x in chosen):
                continue
            use = Counter(n for x in chosen for n in x["numbers"])
            if any(use[n] >= max_use for n in c):
                continue
            if st["pass_rate"] < 6 / 7:
                continue
            chosen.append({"rank": len(chosen) + 1, "group": group, "numbers": list(c), "combo_score": tot,
                           "number_score_mean": round(ns, 4), "structure": st,
                           "tiers": "".join(sorted(tier[x] for x in c))})

    ab = A + B
    core = set(combinations(A, 6))  # A 만으로 된 조합 + (A 가 한 구간에 몰려 구조 조건을 못 채울 때) A 4개 이상 + B 보완
    for _ in range(sample_n // 2):
        c = tuple(sorted(rng.sample(A, 4) + rng.sample(B, 2)))
        core.add(c)
        core.add(tuple(sorted(rng.sample(A, 5) + rng.sample(B, 1))))
    take(pool(core), 3, "core", MAX_PAIR_OVERLAP)
    disp_pool = pool({tuple(sorted(rng.sample(ab, 6))) for _ in range(sample_n)})
    take(disp_pool, 4, "dispersion", MAX_PAIR_OVERLAP)
    abc = A + B + C
    exp = set()
    for _ in range(sample_n):
        c = tuple(sorted(rng.sample(C, 2) + rng.sample([x for x in abc if x not in C or rng.random() < 0.3], 4)))
        if len(set(c)) == 6:
            exp.add(c)
    exp_pool = pool(exp)
    take(exp_pool, 3, "experimental", MAX_PAIR_OVERLAP)
    # 다양성 제한 때문에 개수를 못 채우면 겹침·사용 한도를 1씩만 늘려 한 번 더(구조 조건은 완화하지 않음)
    core_pool = pool(core)
    for relax in (1, 2):
        for grp, k, pl in (("core", 3, core_pool), ("dispersion", 4, disp_pool), ("experimental", 3, exp_pool)):
            if len([x for x in chosen if x["group"] == grp]) < k:
                take(pl, k, grp, MAX_PAIR_OVERLAP + relax, MAX_NUMBER_USE + relax)
    chosen.sort(key=lambda x: ({"core": 0, "dispersion": 1, "experimental": 2}[x["group"]], -x["combo_score"]))
    for i, x in enumerate(chosen, start=1):
        x["rank"] = i
    # 제약을 못 채우면(드묾) 구조 조건만 완화하지 않고 비워 둔다 — 억지 생성 금지
    return chosen


def _votes_for(round_no: int, ptypes: Sequence[str], weights: Dict[str, float],
               exclude: Sequence[str] = ()) -> Tuple[Dict[int, float], Dict[int, float], List[str]]:
    rows = db.query("SELECT prediction_method, predicted_numbers, prediction_type FROM round_prediction_history "
                    "WHERE draw_round = ? AND prediction_rank = 1 AND prediction_status <> 'superseded'", (round_no,))
    votes: Dict[int, float] = {}
    val: Dict[int, float] = {}
    used = []
    seen = set()
    for m, nums, t in rows:
        if t not in ptypes or m in EXCLUDE_VOTES or m.startswith("v12") or m in seen or m in exclude:
            continue
        seen.add(m)
        used.append(m)
        for x in db.loads(nums):
            votes[int(x)] = votes.get(int(x), 0) + 1
            val[int(x)] = val.get(int(x), 0) + weights.get(m, 1.0)
    return votes, val, used


def v12_walk_forward(rounds: Optional[int] = None, store: bool = True) -> Dict[str, Any]:
    """V12 절차 그대로(그 회차 이전 공식 결과 + 그 회차용 백테스트 엔진 추천 + 그 이전까지의 엔진 성과 가중)를
    최근 N회에 적용해 10조합의 실제 일치 수를 무작위(같은 10조합/회차)·기존 단일 엔진과 비교. 가중치 조정 없음."""
    import os

    from . import predictions as P
    from ..stats_engine.draws import load_draws

    rounds = int(rounds or os.environ.get("V12_BACKTEST_ROUNDS", "200"))
    draws = load_draws()
    ser = {m: v for (t, m), v in _series().items() if t == "backtest"}
    targets = [d for d in draws[-rounds:]]
    wf_version = f"{WEIGHTS_VERSION}-wf"
    stored_rounds = {int(r[0]) for r in db.query(
        "SELECT DISTINCT draw_round FROM round_prediction_history WHERE prediction_method = 'v12_integrated' "
        "AND prediction_type = 'backtest' AND engine_version = ?", (wf_version,))}
    written = 0
    idx_of = {d.round: i for i, d in enumerate(draws)}
    res = {"core": [], "dispersion": [], "experimental": [], "all": []}
    leak_violations = 0
    for d in targets:
        prior = draws[:idx_of[d.round]]
        if prior and prior[-1].round >= d.round:
            leak_violations += 1
            continue
        w = {}
        for m, recs in ser.items():
            past = [v[1] for r, v in recs.items() if r < d.round]
            w[m] = (sum(past) / len(past) / EXP) if len(past) >= 20 else 1.0
        votes, val, _used = _votes_for(d.round, ("backtest",), w)
        sc = number_scores(prior, votes, val)
        combos = generate_combos(sc, seed=d.round, sample_n=1500)
        if store and d.round not in stored_rounds and len(_used) >= 3:
            # 그 회차 이전 데이터 + 그 회차용 백테스트 엔진 추천(각자 이전 데이터)만으로 만든 10조합 — 사후 생성 기록
            with db.transaction() as c:
                # 이전 버전 백테스트는 지우지 않고 superseded 로 표시(번호 보존, 집계는 현재 버전만)
                c.execute("UPDATE round_prediction_history SET prediction_status = 'superseded' WHERE draw_round = ? "
                          "AND prediction_method = 'v12_integrated' AND prediction_type = 'backtest' AND engine_version <> ?",
                          (d.round, wf_version))
                for cb in combos:
                    written += P.save_prediction(c, rnd=d.round, method="v12_integrated", ptype="backtest",
                                                 numbers=cb["numbers"], rank=cb["rank"], score=cb["combo_score"],
                                                 engine_version=wf_version,
                                                 training_range=f"{prior[0].round}-{prior[-1].round}",
                                                 training_count=len(prior), note=cb["group"])
        ws = set(d.numbers)
        for c in combos:
            k = len(set(c["numbers"]) & ws)
            res[c["group"]].append(k)
            res["all"].append(k)
    out = {}
    for g, ms in res.items():
        if not ms:
            continue
        means, h3 = _random_portfolio(len(ms), 5000, seed=1212 + len(g))
        mean = sum(ms) / len(ms)
        out[g] = {"games": len(ms), "mean": round(mean, 4), "hit3": sum(1 for x in ms if x >= 3),
                  "random_mean_ci95": [round(float(np.quantile(means, 0.025)), 4), round(float(np.quantile(means, 0.975)), 4)],
                  "p_ge_random": round(float((means >= mean).mean()), 4), "random_hit3_p50": int(np.median(h3))}
    best_single = None
    for m, recs in ser.items():
        if m in EXCLUDE_VOTES:
            continue
        ms = [recs[d.round][1] for d in targets if d.round in recs]
        if len(ms) >= len(targets) * 0.9:
            mean = sum(ms) / len(ms)
            if best_single is None or mean > best_single["mean"]:
                best_single = {"method": m, "mean": round(mean, 4), "rounds": len(ms), "note": "사후에 고른 최고 단일 엔진(낙관적 비교 대상)"}
    p_all = (out.get("all") or {}).get("p_ge_random", 1.0)
    status = "promoted" if p_all < 0.05 / 4 else "candidate_only"
    verdict = ("V12 10조합이 같은 조건 무작위보다 보정 후 유의하게 높음 — 독립 기간 재현 필요" if status == "promoted" else
               "V12 10조합 성과는 같은 조건 무작위 구매와 통계적으로 구분되지 않음 → '후보 생성'만 하고 성능 우위는 주장하지 않음")
    rep = {"kind": "v12_validation", "rounds": len(targets), "from": targets[0].round if targets else None,
           "to": targets[-1].round if targets else None, "groups": out, "best_single_engine": best_single,
           "leak_violations": leak_violations, "weights_version": WEIGHTS_VERSION, "status": status, "verdict": verdict,
           "stored_backtest_predictions": written}
    with db.transaction() as c:
        import uuid

        c.execute("INSERT INTO engine_versions (version_id,engine,params_json,status,selection_range,holdout_range,metrics_json,"
                  "reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  (uuid.uuid4().hex, "v12:integrated", db.dumps({"weights": WEIGHTS, "version": WEIGHTS_VERSION}), status,
                   "사전 고정(선택 없음)", f"{rep['from']}-{rep['to']}", db.dumps(out), verdict, db.now_iso()))
    R._save("v12_validation", rep["to"], rep)
    return rep


def v12_current(save_live: bool = True) -> Dict[str, Any]:
    from datetime import date, datetime, timedelta, timezone

    from . import predictions as P
    from ..stats_engine.draws import load_draws

    draws = load_draws()
    latest = draws[-1]
    target = latest.round + 1
    draw_day = date(2002, 12, 7) + timedelta(days=7 * (target - 1))
    cutoff = P.draw_cutoff(target)
    v9 = R.last_report("v9") or {}
    w = {x["method"]: (x["periods"]["all"].get("mean") or EXP) / EXP for x in v9.get("methods", []) if x["type"] == "backtest"}
    try:
        from . import round_audit as _RA

        audit_excluded = sorted(_RA.excluded_methods())
    except Exception:  # noqa: BLE001
        audit_excluded = []
    votes, val, used = _votes_for(target, ("live",), w, exclude=audit_excluded)
    vote_source = "live(대상 회차 사전 예측)"
    if not used:  # 아직 live 예측이 없으면 회차통계 순위로 대체(같은 이전 데이터)
        from ..stats_engine.backtest import _rankings

        for idx, st in R._walk(draws):
            if idx == len(draws):
                ranks = _rankings(st.freq, st.last_seen, st.pair, st.prev, idx)
                for s, rk in ranks.items():
                    used.append(f"stats_{s}")
                    for x in rk[:6]:
                        votes[x] = votes.get(x, 0) + 1
                        val[x] = val.get(x, 0) + w.get(f"stats_{s}", 1.0)
        vote_source = "회차통계 6전략 즉시 계산(live 미생성)"
    sc = number_scores(draws, votes, val)
    try:  # 두 기간에서 재현된 당첨 패턴만 점수 보정(없으면 변화 없음)
        from . import round_audit as _RA

        bonus = _RA.adopted_pattern_bonus(draws)
    except Exception:  # noqa: BLE001
        bonus = {}
    if bonus:
        for r_ in sc:
            r_["score"] = round(r_["score"] + bonus.get(r_["number"], 0.0), 4)
            r_["pattern_bonus"] = bonus.get(r_["number"], 0.0)
        sc.sort(key=lambda r_: (-r_["score"], r_["number"]))
        for i, r_ in enumerate(sc, start=1):
            r_["rank"] = i
            r_["tier"] = "A" if i <= 10 else "B" if i <= 20 else "C" if i <= 30 else "-"
    combos = generate_combos(sc, seed=target)
    now = datetime.now(timezone.utc)
    saved = 0
    note = None
    if save_live:
        if now >= cutoff:
            note = "cutoff 이후 — 사전 예측으로 저장하지 않음(표시만)"
        else:
            with db.transaction() as c:
                for cb in combos:
                    saved += P.save_prediction(c, rnd=target, method="v12_integrated", ptype="live", numbers=cb["numbers"],
                                               rank=cb["rank"], score=cb["combo_score"], engine_version=WEIGHTS_VERSION,
                                               cutoff_at=cutoff.isoformat(), training_range=f"{draws[0].round}-{latest.round}",
                                               training_count=len(draws), note=cb["group"])
    # 이미 저장된 사전 예측이 있으면(불변) 그것을 정본으로 표시 — 재실행 결과로 바꾸지 않음
    stored = db.query("SELECT prediction_rank, predicted_numbers, prediction_score, source_note, prediction_created_at "
                      "FROM round_prediction_history WHERE draw_round = ? AND prediction_method = 'v12_integrated' "
                      "AND prediction_type = 'live' ORDER BY prediction_rank", (target,))
    frozen_at = None
    if stored:
        sc_map = {r["number"]: r for r in sc}
        ref = R.reference()
        sr = (int(ref["sum_range95"][0]) + 15, int(ref["sum_range95"][1]) - 15)
        combos = [{"rank": int(rk), "group": grp or "-", "numbers": db.loads(nums), "combo_score": sco,
                   "number_score_mean": round(sum(sc_map[x]["score"] for x in db.loads(nums)) / 6, 4),
                   "structure": structure(db.loads(nums), sr),
                   "tiers": "".join(sorted(sc_map[x]["tier"] for x in db.loads(nums)))} for rk, nums, sco, grp, _c in stored]
        frozen_at = stored[0][4]
    val_rep = R.last_report("v12_validation") or {}
    rep = {"kind": "v12", "latest_official_round": latest.round, "latest_draw_date": latest.draw_date,
           "latest_numbers": list(latest.numbers), "latest_bonus": latest.bonus, "target_round": target,
           "draw_date": draw_day.isoformat(), "data_cutoff_utc": cutoff.isoformat(), "data_cutoff_kst": f"{draw_day.isoformat()} 20:00 KST",
           "data_basis": f"1~{latest.round}회 공식 결과", "vote_source": vote_source, "engines_voting": used, "engines_excluded_by_audit": audit_excluded,
           "numbers": sc, "groups": {"A": [r["number"] for r in sc if r["tier"] == "A"],
                                      "B": [r["number"] for r in sc if r["tier"] == "B"],
                                      "C": [r["number"] for r in sc if r["tier"] == "C"]},
           "combos": combos, "combos_frozen_at": frozen_at, "saved_live_predictions": saved, "save_note": note, "weights": WEIGHTS,
           "weights_version": WEIGHTS_VERSION, "validation": {k: val_rep.get(k) for k in ("status", "verdict", "groups", "from", "to")},
           "probability": {"each_combo_first_prize": "1/8,145,060", "ten_combos_first_prize": "10/8,145,060 (서로 다른 10조합)",
                           "expected_matches_per_combo": EXP,
                           "statement": "번호·조합 점수는 과거 데이터 요약 지표이며 당첨 확률을 바꾸지 않습니다."}}
    R._save("v12", latest.round, rep)
    return rep


# ─────────────────────────────── 통합 실행 · 보고 ───────────────────────────────

def run_master() -> Dict[str, Any]:
    """진단 → 기록 수집 → 공식 결과 대조 → 누수 검사 → 역분석 → 수정(V6/V7) → V9~V11 → V12 검증 → 현재 회차 후보."""
    from . import predictions as P

    steps = {}
    steps["diagnose"] = len(diagnose_engines()["prediction_methods"])
    steps["evaluate"] = P.evaluate_pending()
    steps["v8"] = v8_leakage()["status"]
    steps["v7"] = R.self_optimize(force=False).get("decision") or "skipped_same_round"
    steps["v9"] = len(v9_reliability()["methods"])
    steps["v10"] = v10_number_bias()["most_over_recommended"]
    steps["v11"] = len(v11_random_sim()["methods"])
    wf = v12_walk_forward()
    steps["v12_validation"] = wf["status"]
    steps["v12_backtest_stored"] = wf.get("stored_backtest_predictions", 0)
    steps["evaluate_backfill"] = P.evaluate_pending()
    try:  # 전 회차 후보군 성적 감사 → 하락 후보군은 이번 회차 V12 투표에서 제외
        from . import round_audit as _RA

        ra = _RA.audit()
        steps["round_audit"] = {"summary": ra["summary"], "excluded": ra["actions"]["excluded_now"]}
        steps["miss_analysis"] = _RA.miss_analysis().get("adopted_patterns")
    except Exception as exc:  # noqa: BLE001
        steps["round_audit"] = {"error": str(exc)[:200]}
    cur = v12_current()
    steps["v12"] = {"target_round": cur["target_round"], "saved": cur["saved_live_predictions"], "note": cur["save_note"]}
    return steps


def full_report() -> Dict[str, Any]:
    R._ensure()
    return {"diagnosis": diagnose_engines(), "v8": R.last_report("v8"), "v9": R.last_report("v9"),
            "v10": R.last_report("v10"), "v11": R.last_report("v11"), "v12": R.last_report("v12"),
            "v12_validation": R.last_report("v12_validation"), "v5": R.last_report("v5"), "v6": R.last_report("v6"),
            "v7": R.last_report("v7"), "probability": R.probability_check()}
