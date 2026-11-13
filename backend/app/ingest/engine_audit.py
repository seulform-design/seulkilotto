"""엔진 성능 감사 · 공통번호 교차검증(V5) · 번호별 통계(V6) · 상관 보정 앙상블(V7) · 자동 감사(V8).

입력은 round_prediction_history / round_prediction_evaluation 에 이미 영구 저장된 회차별 예측(백테스트·사전예측)이다.
각 회차의 예측은 그 회차 이전 데이터만으로 만들어졌으므로(저장 시 training_data_range 로 확인) 여기서의 모든
집계도 '그 회차 당시 존재했던 엔진 예측'만 쓴다.

원칙
- 엔진을 자동으로 덮어쓰지 않는다. 개선 후보는 engine_versions 에 'candidate' 로 등록되고, 선택 기간과 분리된
  홀드아웃 기간에서 무작위·기존 버전 대비 Bonferroni 보정 후 유의할 때만 'promoted'.
- 통계적으로 입증되지 않은 결과는 '미검증'으로 표시한다. 1등 확률(1/8,145,060)은 어떤 결과로도 바뀌지 않는다.
"""
from __future__ import annotations

import math
import random
import uuid
from itertools import combinations
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import db

EXP = 0.8                                   # 1조합 기대 일치 수(6·6/45)
VAR1 = 6 * (6 / 45) * (39 / 45) * (39 / 44)  # 1조합 일치 수 분산(초기하)
P_NUM = 6 / 45                              # 한 번호가 당첨 6개에 포함될 확률
AUDIT_TABLES = [
    """CREATE TABLE IF NOT EXISTS engine_versions (
        version_id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        selection_range TEXT,
        holdout_range TEXT,
        metrics_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS engine_audits (
        audit_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        latest_round INTEGER,
        alerts_json TEXT NOT NULL,
        summary_json TEXT NOT NULL
    )""",
]
_READY: Dict[str, bool] = {}


def _ensure() -> None:
    from . import predictions

    predictions._ensure()
    k = db.backend()
    if _READY.get(k):
        return
    with db.transaction() as c:
        for s in AUDIT_TABLES:
            c.execute(s)
    _READY[k] = True


def reset_for_tests() -> None:
    _READY.clear()


def _sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2))


def _load(ptype: str = "backtest") -> Dict[str, Dict[int, Tuple[List[int], int, int]]]:
    """method → round → (예측 번호, 일치 수, 보너스 일치). rank 1(회차당 1조합)만."""
    _ensure()
    rows = db.query(
        "SELECT h.prediction_method, h.draw_round, h.predicted_numbers, e.match_count, e.bonus_matched "
        "FROM round_prediction_history h JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id "
        "WHERE h.prediction_type = ? AND h.prediction_rank = 1 AND h.prediction_status <> 'superseded'", (ptype,))
    out: Dict[str, Dict[int, Tuple[List[int], int, int]]] = {}
    for m, r, nums, mc, bm in rows:
        out.setdefault(m, {})[int(r)] = (db.loads(nums), int(mc), int(bm))
    return out


def _winning() -> Dict[int, Tuple[Tuple[int, ...], int]]:
    from ..stats_engine.draws import load_draws

    return {d.round: (d.numbers, d.bonus) for d in load_draws()}


def _stats(matches: Sequence[int], bonus: Sequence[int] = ()) -> Dict[str, Any]:
    n = len(matches)
    if not n:
        return {"rounds": 0}
    mean = sum(matches) / n
    se = math.sqrt(VAR1 / n)
    z = (mean - EXP) / se
    dist = [matches.count(k) for k in range(7)]
    return {"rounds": n, "mean": round(mean, 4), "ci95": [round(mean - 1.96 * se, 4), round(mean + 1.96 * se, 4)],
            "z": round(z, 3), "p_above": round(_sf(z), 4), "p_below": round(_sf(-z), 4),
            "rates": {str(k): round(dist[k] / n, 4) for k in range(7)},
            "rate_3plus": round(sum(dist[3:]) / n, 4), "rate_4plus": round(sum(dist[4:]) / n, 4),
            "rate_5plus": round(sum(dist[5:]) / n, 5), "six": dist[6],
            "bonus_rate": round(sum(bonus) / n, 4) if bonus else None}


# ─────────────────────────────── Phase 2: 성능·저성과 진단 ───────────────────────────────

PERIODS = [("all", None), ("last100", 100), ("last50", 50), ("last30", 30), ("last10", 10)]


def performance_by_period(ptype: str = "backtest") -> Dict[str, Any]:
    data = _load(ptype)
    latest = max((max(v) for v in data.values() if v), default=0)
    methods = [m for m in data if m != "random_baseline"]
    alpha = 0.05 / max(1, len(methods))
    out = []
    for m, recs in data.items():
        per = {}
        for name, w in PERIODS:
            rs = sorted(recs)
            if w:
                rs = [r for r in rs if r > latest - w]
            per[name] = _stats([recs[r][1] for r in rs], [recs[r][2] for r in rs])
        allp = per["all"]
        diag = diagnose(m, recs, per, alpha)
        out.append({"method": m, "periods": per, "diagnosis": diag})
    out.sort(key=lambda x: -(x["periods"]["all"].get("mean") or 0))
    return {"latest_round": latest, "bonferroni_alpha": round(alpha, 5), "methods": out,
            "expected_mean": EXP, "note": "기간별 평균은 같은 엔진의 회차 수가 달라 표본 크기를 함께 보세요."}


def diagnose(method: str, recs: Dict[int, Tuple[List[int], int, int]], per: Dict[str, Any], alpha: float) -> Dict[str, Any]:
    """저성과 원인 분류 — 대부분은 '무작위 변동'으로 판정되는 것이 정상(로또 i.i.d.)."""
    a = per["all"]
    n = a.get("rounds", 0)
    causes: List[str] = []
    status = "normal"
    if n < 30:
        status, causes = "insufficient_data", ["학습/평가 표본 30회 미만 — 성능 판정 보류"]
    elif a["p_below"] < alpha:
        status = "underperform_significant"
        causes.append("보정 후에도 무작위보다 유의하게 낮음 — 특징량·파라미터 점검 대상")
    elif a["p_above"] < alpha:
        status = "outperform_significant"
        causes.append("보정 후 무작위보다 유의하게 높음 — 독립 기간 재현 확인 필요")
    else:
        causes.append("무작위와 통계적으로 구분되지 않음(성능 변동은 무작위 변동 범위)")
    r30 = per["last30"]
    if r30.get("rounds", 0) >= 30 and a.get("rounds", 0) >= 100:
        diff = r30["mean"] - a["mean"]
        se = math.sqrt(VAR1 / 30 + VAR1 / a["rounds"])
        zt = diff / se
        if zt < -2.5:
            causes.append(f"최근 30회 하락(z={zt:.2f}) — 재학습 전에 무작위 변동 여부 확인(단순 하락만으로 교체 안 함)")
            if status == "normal":
                status = "recent_drop_watch"
    # 누수 점검: 저장된 학습 범위가 예측 회차 이후를 포함하는지
    leak = db.query("SELECT COUNT(*) FROM round_prediction_history WHERE prediction_method = ? AND prediction_type='backtest' "
                    "AND training_data_range LIKE '%-%' AND training_data_range NOT LIKE 'round%'", (method,))
    leaks = _leak_rows(method)
    if leaks:
        status = "leak_detected"
        causes.append(f"미래 데이터 포함 예측 {leaks}건 — 평가에서 제외해야 함")
    return {"status": status, "causes": causes, "leak_rows": leaks, "checked_rows": int(leak[0][0]) if leak else 0}


def _leak_rows(method: str) -> int:
    rows = db.query("SELECT draw_round, training_data_range FROM round_prediction_history WHERE prediction_method = ? "
                    "AND prediction_type = 'backtest'", (method,))
    bad = 0
    for r, rng in rows:
        try:
            last = int(str(rng).split("-")[1])
            if last >= int(r):
                bad += 1
        except (IndexError, ValueError):
            continue
    return bad


# ─────────────────────────────── 개선 실험(후보 → 홀드아웃 → 승격) ───────────────────────────────

def improvement_experiment(selection_end: Optional[int] = None) -> Dict[str, Any]:
    """회차통계 엔진 개선 후보 — 출현 집계 창 W(10/30/50/100/전체) × 방향(hot/cold).
    선택 기간에서 최고 후보를 고르고(사후 선택), 그 후보를 '선택에 쓰지 않은' 홀드아웃 기간에서만 평가.
    홀드아웃에서 무작위·기존 버전보다 보정 후 유의할 때만 승격. 아니면 기존 유지."""
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    if len(draws) < 300:
        return {"status": "insufficient_data"}
    latest = draws[-1].round
    selection_end = selection_end or (draws[0].round + int(len(draws) * 0.7))
    windows = [10, 30, 50, 100, None]
    cands = [(d, w) for d in ("hot", "cold") for w in windows]

    def picks_for(idx: int, direction: str, w: Optional[int]) -> List[int]:
        sub = draws[max(0, idx - w):idx] if w else draws[:idx]
        cnt = [0] * 46
        for d in sub:
            for n in d.numbers:
                cnt[n] += 1
        order = sorted(range(1, 46), key=lambda n: ((-cnt[n]) if direction == "hot" else cnt[n], n))
        return order[:6]

    res: Dict[Tuple[str, Optional[int]], Dict[str, List[int]]] = {c: {"sel": [], "hold": []} for c in cands}
    for idx in range(50, len(draws)):
        d = draws[idx]
        part = "sel" if d.round <= selection_end else "hold"
        wset = set(d.numbers)
        for c in cands:
            res[c][part].append(len(set(picks_for(idx, *c)) & wset))
    sel_scores = {c: sum(v["sel"]) / len(v["sel"]) for c, v in res.items()}
    best = max(sel_scores, key=sel_scores.get)
    baseline = ("hot", None)  # 기존 운영 버전(stats_hot: 전체 누적)
    hb, hbase = res[best]["hold"], res[baseline]["hold"]
    n = len(hb)
    mean_b = sum(hb) / n
    mean_0 = sum(hbase) / n
    z_rand = (mean_b - EXP) / math.sqrt(VAR1 / n)
    diffs = [a - b for a, b in zip(hb, hbase)]
    md = sum(diffs) / n
    sd = math.sqrt(sum((x - md) ** 2 for x in diffs) / max(1, n - 1)) or 1e-9
    z_old = md / (sd / math.sqrt(n))
    alpha = 0.05 / len(cands)  # 후보 수만큼 다중검정 보정
    promoted = bool(_sf(z_rand) < alpha and _sf(z_old) < alpha)
    metrics = {"selection_mean": {f"{d}:{w or 'all'}": round(v, 4) for (d, w), v in sel_scores.items()},
               "best_candidate": f"{best[0]}:{best[1] or 'all'}", "holdout_rounds": n,
               "holdout_mean_candidate": round(mean_b, 4), "holdout_mean_current": round(mean_0, 4),
               "z_vs_random": round(z_rand, 3), "p_vs_random": round(_sf(z_rand), 4),
               "z_vs_current": round(z_old, 3), "p_vs_current": round(_sf(z_old), 4), "alpha_bonferroni": round(alpha, 4)}
    status = "promoted" if promoted else "rejected"
    reason = ("홀드아웃에서 무작위·기존 대비 보정 후 유의 — 새 버전 승격" if promoted else
              "선택 기간 최고 후보도 홀드아웃에서 무작위·기존 버전과 유의한 차이 없음 → 기존 버전 유지(과적합 방지)")
    with db.transaction() as c:
        c.execute("INSERT INTO engine_versions (version_id,engine,params_json,status,selection_range,holdout_range,metrics_json,"
                  "reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  (uuid.uuid4().hex, "stats_frequency", db.dumps({"direction": best[0], "window": best[1]}), status,
                   f"{draws[50].round}-{selection_end}", f"{selection_end + 1}-{latest}", db.dumps(metrics), reason,
                   db.now_iso()))
    return {"status": status, "reason": reason, **metrics}


def versions() -> List[Dict[str, Any]]:
    _ensure()
    rows = db.query("SELECT version_id, engine, params_json, status, selection_range, holdout_range, metrics_json, reason, "
                    "created_at FROM engine_versions ORDER BY created_at DESC LIMIT 20")
    return [{"version_id": r[0], "engine": r[1], "params": db.loads(r[2]), "status": r[3], "selection_range": r[4],
             "holdout_range": r[5], "metrics": db.loads(r[6]), "reason": r[7], "created_at": r[8]} for r in rows]


# ─────────────────────────────── V5 공통번호 교차검증 ───────────────────────────────

def _family(m: str) -> str:
    return m.split("_")[0]


def consensus(ptype: str = "backtest", recent: Optional[int] = None) -> Dict[str, Any]:
    """회차별로 그 회차 당시 존재한 엔진 예측만으로 번호별 선택 수를 집계하고, 'k개 이상 엔진이 고른 번호'의
    실제 적중률을 무작위(번호당 6/45)와 비교. 엔진 간 유사도·유효 독립 엔진 수도 함께 계산."""
    data = {m: v for m, v in _load(ptype).items() if m != "random_baseline"}
    win = _winning()
    rounds = sorted({r for v in data.values() for r in v})
    if recent:
        rounds = rounds[-recent:]
    by_k: Dict[int, List[Tuple[int, int]]] = {}
    sel_count = [0] * 46
    sel_hits = [0] * 46
    per_round_cons: Dict[int, Dict[int, int]] = {}
    for r in rounds:
        engines = [m for m in data if r in data[m]]
        if len(engines) < 2 or r not in win:
            continue
        cnt = [0] * 46
        for m in engines:
            for n in data[m][r][0]:
                cnt[n] += 1
        wset = set(win[r][0])
        per_round_cons[r] = {n: cnt[n] for n in range(1, 46) if cnt[n]}
        for n in range(1, 46):
            if cnt[n]:
                sel_count[n] += 1
                sel_hits[n] += int(n in wset)
        for k in range(2, len(engines) + 1):
            chosen = [n for n in range(1, 46) if cnt[n] >= k]
            if chosen:
                by_k.setdefault(k, []).append((len(chosen), sum(1 for n in chosen if n in wset)))
    alpha = 0.05 / max(1, len(by_k))
    tests = []
    for k, recs in sorted(by_k.items()):
        trials = sum(a for a, _ in recs)
        hits = sum(b for _, b in recs)
        exp = trials * P_NUM
        sd = math.sqrt(trials * P_NUM * (1 - P_NUM)) or 1e-9
        z = (hits - exp) / sd
        rate = hits / trials if trials else 0
        tests.append({"min_engines": k, "rounds": len(recs), "numbers_selected": trials, "hits": hits,
                      "hit_rate": round(rate, 4), "random_rate": round(P_NUM, 4),
                      "lift": round(rate / P_NUM, 3) if trials else None, "z": round(z, 3), "p_value": round(_sf(z), 4),
                      "significant": bool(len(recs) >= 30 and _sf(z) < alpha and hits > exp)})
    indep = independence(data, rounds)
    any_sig = any(t["significant"] for t in tests)
    return {
        "prediction_type": ptype, "rounds_used": len(per_round_cons), "engines": sorted(data),
        "threshold_tests": tests, "bonferroni_alpha": round(alpha, 5),
        "number_selection": [{"number": n, "rounds_selected": sel_count[n], "hits_when_selected": sel_hits[n],
                              "hit_rate": round(sel_hits[n] / sel_count[n], 4) if sel_count[n] else None}
                             for n in range(1, 46)],
        "independence": indep,
        "verdict": ("일부 공통번호 기준이 보정 후 무작위보다 유의 — 재현 확인 필요" if any_sig else
                    "공통 선택 번호의 적중률은 무작위(6/45)와 유의한 차이가 없습니다 — 공통번호의 예측력은 입증되지 않았습니다."),
        "latest_consensus": _latest_consensus(ptype),
    }


def _latest_consensus(ptype: str) -> Dict[str, Any]:
    """가장 최근 회차(사전 예측이 있으면 그 회차)의 엔진별 공통번호 분류 A~G."""
    data = {m: v for m, v in _load("live").items() if m != "random_baseline"} or \
        {m: v for m, v in _load(ptype).items() if m != "random_baseline"}
    if not data:
        return {}
    r = max(max(v) for v in data.values())
    engines = [m for m in data if r in data[m]]
    cnt = {n: [m for m in engines if n in data[m][r][0]] for n in range(1, 46)}
    E = len(engines)
    fams = sorted({_family(m) for m in engines})
    return {
        "round": r, "engines": E,
        "A_all_engines": [n for n, ms in cnt.items() if len(ms) == E and E],
        "B_majority": [n for n, ms in cnt.items() if len(ms) > E / 2],
        "C_family_repeat": {f: [n for n, ms in cnt.items() if sum(1 for m in ms if _family(m) == f) >= 2] for f in fams},
        "G_split": [n for n, ms in cnt.items() if 0 < len(ms) and len({_family(m) for m in ms}) == 1 and len(ms) >= 2],
        "selections": {str(n): ms for n, ms in cnt.items() if ms},
    }


def independence(data: Dict[str, Dict[int, Tuple[List[int], int, int]]], rounds: Sequence[int]) -> Dict[str, Any]:
    """엔진 쌍별 평균 Jaccard(무작위 두 조합 기대 ≈ 0.0997) + 번호 선택 상관 기반 유효 독립 엔진 수."""
    methods = sorted(data)
    pairs = []
    for a, b in combinations(methods, 2):
        common = [r for r in rounds if r in data[a] and r in data[b]]
        if not common:
            continue
        js = [len(set(data[a][r][0]) & set(data[b][r][0])) / len(set(data[a][r][0]) | set(data[b][r][0])) for r in common]
        pairs.append({"a": a, "b": b, "rounds": len(common), "jaccard": round(sum(js) / len(js), 4),
                      "identical_rate": round(sum(1 for r in common if sorted(data[a][r][0]) == sorted(data[b][r][0])) / len(common), 4)})
    # 유효 독립 엔진 수: 쌍별 Jaccard 를 유사도로 보고 n_eff = n² / Σ_ij s_ij (s_ii=1)
    n = len(methods)
    sim = {(p["a"], p["b"]): p["jaccard"] for p in pairs}
    tot = n + 2 * sum(max(0.0, (s - 0.0997) / (1 - 0.0997)) for s in sim.values())
    n_eff = round(n * n / tot, 2) if tot else None
    pairs.sort(key=lambda p: -p["jaccard"])
    return {"pairs": pairs[:30], "random_jaccard_expected": 0.0997, "engines": n, "effective_independent_engines": n_eff,
            "duplicates": [p for p in pairs if p["identical_rate"] >= 0.9],
            "note": "같은 데이터·비슷한 계산식의 엔진은 공통 선택이 독립 증거가 아닙니다 — 유효 독립 엔진 수로 보정."}


# ─────────────────────────────── V6 번호별 통계 ───────────────────────────────

def number_stats() -> Dict[str, Any]:
    from ..stats_engine.draws import load_draws

    draws = load_draws()
    N = len(draws)
    out = []
    alpha = 0.05 / 45
    for n in range(1, 46):
        row: Dict[str, Any] = {"number": n}
        for name, w in (("all", None), ("last100", 100), ("last50", 50), ("last30", 30), ("last10", 10)):
            sub = draws[-w:] if w else draws
            c = sum(1 for d in sub if n in d.numbers)
            exp = len(sub) * P_NUM
            sd = math.sqrt(len(sub) * P_NUM * (1 - P_NUM))
            z = (c - exp) / sd if sd else 0
            row[name] = {"count": c, "expected": round(exp, 2), "z": round(z, 2),
                         "p_two_sided": round(math.erfc(abs(z) / math.sqrt(2)), 4)}
        # 변동성: 100회 블록별 출현 수의 표준편차
        blocks = [sum(1 for d in draws[i:i + 100] if n in d.numbers) for i in range(0, N - 99, 100)]
        mu = sum(blocks) / len(blocks) if blocks else 0
        row["block100_sd"] = round(math.sqrt(sum((b - mu) ** 2 for b in blocks) / max(1, len(blocks) - 1)), 2) if blocks else None
        row["block100_expected_sd"] = round(math.sqrt(100 * P_NUM * (1 - P_NUM)), 2)
        row["significant_all_bonferroni"] = row["all"]["p_two_sided"] < alpha
        out.append(row)
    return {"rounds": N, "theoretical_probability_per_draw": round(P_NUM, 4), "bonferroni_alpha": round(alpha, 5),
            "numbers": out, "any_significant": any(r["significant_all_bonferroni"] for r in out),
            "note": "번호별 출현 편차는 추정값입니다. 다음 회차 확률은 모든 번호 6/45(=13.3%)로 동일하며, "
                    "편차는 예측 성능이 검증될 때만 모델에 반영합니다."}


# ─────────────────────────────── V7 상관 보정 앙상블 검증 ───────────────────────────────

def ensemble_validation(ptype: str = "backtest", warm: int = 30) -> Dict[str, Any]:
    """각 회차 R 에서, R 이전 회차 성적만으로 엔진 가중치(무작위 대비 초과 일치 × 독립성 보정, 0 이하=동일가중)를
    정하고 엔진 예측 번호의 가중 투표 top6 를 고른다. 그 결과를 개별 엔진·동일가중 앙상블·무작위와 비교."""
    data = {m: v for m, v in _load(ptype).items() if m != "random_baseline"}
    win = _winning()
    rounds = sorted({r for v in data.values() for r in v if r in win})
    hist: Dict[str, List[int]] = {m: [] for m in data}
    ens_w, ens_eq = [], []
    for r in rounds:
        engines = [m for m in data if r in data[m]]
        if len(engines) < 2:
            continue
        # 가중치: 이전 성적(최소 warm 회)의 평균 초과분을 표준오차로 나눈 z 를 0~ 로 자르고, 같은 계열 수로 나눠 중복 보정
        fam_n: Dict[str, int] = {}
        for m in engines:
            fam_n[_family(m)] = fam_n.get(_family(m), 0) + 1
        w = {}
        for m in engines:
            h = hist[m]
            if len(h) >= warm:
                z = (sum(h) / len(h) - EXP) / math.sqrt(VAR1 / len(h))
                w[m] = max(0.0, z) / fam_n[_family(m)]
            else:
                w[m] = 0.0
        if sum(w.values()) == 0:
            w = {m: 1.0 / fam_n[_family(m)] for m in engines}
        score = [0.0] * 46
        eq = [0.0] * 46
        for m in engines:
            for n in data[m][r][0]:
                score[n] += w[m]
                eq[n] += 1.0 / fam_n[_family(m)]
        wset = set(win[r][0])
        top_w = sorted(range(1, 46), key=lambda n: (-score[n], n))[:6]
        top_e = sorted(range(1, 46), key=lambda n: (-eq[n], n))[:6]
        ens_w.append(len(set(top_w) & wset))
        ens_eq.append(len(set(top_e) & wset))
        for m in engines:  # 채점 후 갱신(누수 없음)
            hist[m].append(data[m][r][1])
    singles = {m: _stats([v[1] for r, v in sorted(recs.items()) if r in win]) for m, recs in data.items()}
    best_single = max(singles.items(), key=lambda kv: kv[1].get("mean") or 0) if singles else (None, {})
    res = {"weighted_ensemble": _stats(ens_w), "equal_ensemble_family_adjusted": _stats(ens_eq),
           "best_single": {"method": best_single[0], **best_single[1]}, "rounds": len(ens_w)}
    we = res["weighted_ensemble"]
    improved = bool(we.get("rounds", 0) >= 100 and we["p_above"] < 0.05 / 3)
    res["promote"] = improved
    res["verdict"] = ("가중 앙상블이 무작위보다 보정 후 유의 — 후보로 기록(재현 확인 후 운영)" if improved else
                      "상관 보정 앙상블도 무작위·개별 엔진과 유의한 차이 없음 → 운영 앙상블 가중치 변경 안 함")
    return res


# ─────────────────────────────── V8 자동 감사 ───────────────────────────────

def run_audit() -> Dict[str, Any]:
    _ensure()
    perf = performance_by_period()
    cons = consensus()
    alerts: List[Dict[str, Any]] = []
    for m in perf["methods"]:
        st = m["diagnosis"]["status"]
        if st in ("underperform_significant", "leak_detected", "recent_drop_watch", "outperform_significant"):
            alerts.append({"method": m["method"], "type": st, "detail": m["diagnosis"]["causes"]})
    for d in cons["independence"]["duplicates"]:
        alerts.append({"method": f"{d['a']} ~ {d['b']}", "type": "duplicate_engines",
                       "detail": [f"예측 조합 {round(d['identical_rate'] * 100)}% 동일 — 이름만 다른 같은 알고리즘 의심"]})
    try:
        from ..stats_engine.windows import build_window_stats

        if (build_window_stats().get("multiple_testing") or {}).get("any_significant"):
            alerts.append({"method": "data", "type": "distribution_shift", "detail": ["회차 분포가 보정 후 균등과 다름 — 데이터 오류 먼저 확인"]})
    except Exception:  # noqa: BLE001
        pass
    small = [m["method"] for m in perf["methods"] if m["periods"]["all"].get("rounds", 0) < 30]
    if small:
        alerts.append({"method": ",".join(small), "type": "insufficient_data", "detail": ["평가 표본 30회 미만 — 판정 보류"]})
    summary = {"methods": len(perf["methods"]), "alerts": len(alerts),
               "effective_independent_engines": cons["independence"]["effective_independent_engines"],
               "consensus_verdict": cons["verdict"]}
    with db.transaction() as c:
        c.execute("INSERT INTO engine_audits (audit_id,created_at,latest_round,alerts_json,summary_json) VALUES (?,?,?,?,?)",
                  (uuid.uuid4().hex, db.now_iso(), perf["latest_round"], db.dumps(alerts), db.dumps(summary)))
    return {"alerts": alerts, "summary": summary}


def last_audit() -> Optional[Dict[str, Any]]:
    _ensure()
    r = db.query("SELECT created_at, latest_round, alerts_json, summary_json FROM engine_audits ORDER BY created_at DESC LIMIT 1")
    return {"created_at": r[0][0], "latest_round": r[0][1], "alerts": db.loads(r[0][2]), "summary": db.loads(r[0][3])} if r else None


def number_detail(n: int, limit: int = 30) -> Dict[str, Any]:
    """번호 클릭 상세 — 그 번호를 고른 엔진과 회차별 기록."""
    data = _load("backtest")
    win = _winning()
    by_round: Dict[int, List[str]] = {}
    for m, recs in data.items():
        if m == "random_baseline":
            continue
        for r, (nums, _mc, _bm) in recs.items():
            if n in nums:
                by_round.setdefault(r, []).append(m)
    items = [{"round": r, "engines": sorted(ms), "was_drawn": bool(r in win and n in win[r][0])}
             for r, ms in sorted(by_round.items(), reverse=True)[:limit]]
    return {"number": n, "rounds_selected": len(by_round),
            "hits": sum(1 for r in by_round if r in win and n in win[r][0]), "recent": items}


def full_report() -> Dict[str, Any]:
    perf = performance_by_period()
    cons = consensus()
    ens = ensemble_validation()
    vers = versions()
    worst = min(perf["methods"], key=lambda m: m["periods"]["all"].get("mean") or 9) if perf["methods"] else None
    return {
        "performance": perf, "consensus": cons, "ensemble": ens, "versions": vers, "audit": last_audit(),
        "answers": {
            "lowest_engine": worst and {"method": worst["method"], "mean": worst["periods"]["all"].get("mean"),
                                        "rounds": worst["periods"]["all"].get("rounds"), "diagnosis": worst["diagnosis"]},
            "improved_engines": [v for v in vers if v["status"] == "promoted"],
            "consensus_beats_random": any(t["significant"] for t in cons["threshold_tests"]),
            "effective_independent_engines": cons["independence"]["effective_independent_engines"],
            "ensemble_promoted": ens["promote"],
            "statistically_supported_claims": (
                "보정 후 무작위를 유의하게 이기는 엔진·공통번호·앙상블이 없으면, 주장할 수 있는 것은 "
                "'모든 방법이 무작위(평균 0.8개)와 구분되지 않는다'는 것뿐입니다. 1등 확률은 조합당 1/8,145,060."),
        },
    }
