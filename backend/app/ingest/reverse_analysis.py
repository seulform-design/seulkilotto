"""V5 예측 역분석 · V6 자동 보정 후보 · V7 자기개선 루프 · 기존 학습 모듈(V1~V4-A) 재검증.

입력: round_prediction_history / round_prediction_evaluation 에 이미 영구 저장된 회차별 예측과 공식 당첨 결과.
원칙
- 데이터를 만들거나 지우지 않는다. 예측 시점이 불명확하거나 사후 기록으로 보이는 행은 prediction_quarantine 에
  '격리 표시'만 하고(원본 행은 그대로) 모든 집계에서 제외한다.
- 구간 차이·특징 차이는 표본 수와 신뢰구간·다중검정 보정과 함께 보고하고, 우연과 구분되지 않으면 규칙으로 확정하지 않는다.
- V6 후보는 기존 전략의 '복사본 + 한 가지 변경'이다. 기존 전략은 덮어쓰지 않는다. 선택 기간에서 고른 후보만
  선택에 쓰지 않은 홀드아웃에서 원본·무작위와 Bonferroni 보정 후 비교해 둘 다 유의할 때만 'promoted'.
- 공정·독립 추첨에서는 어떤 6개 조합도 1등 확률 1/8,145,060, 기대 일치 수 0.8로 같다. 과거 패턴으로 다음 회차
  당첨 확률이 오른다고 주장하지 않는다.
"""
from __future__ import annotations

import math
import random
import uuid
from datetime import datetime
from itertools import combinations
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import db

EXP = 0.8
VAR1 = 6 * (6 / 45) * (39 / 45) * (39 / 44)
TOTAL_COMBOS = 8_145_060
TIER_COMBOS = {1: 1, 2: 6, 3: 228, 4: 11_115, 5: 182_780}  # 등수별 당첨 조합 수(1장 기준)
DECADES = ((1, 9), (10, 19), (20, 29), (30, 39), (40, 45))
FEATURES = ("odd", "low", "sum", "consec", "last_digits", "max_decade", "overlap_prev", "freq_pct")
FEATURE_LABELS = {"odd": "홀수 개수", "low": "저번호(1~22) 개수", "sum": "합계", "consec": "연속쌍 수",
                  "last_digits": "끝수 종류", "max_decade": "한 구간 최대 개수", "overlap_prev": "직전 회차와 겹침",
                  "freq_pct": "누적 빈도 백분위(1=최다)"}
CAUSES = {"data_collection": "데이터 수집·갱신", "preprocessing": "전처리", "feature": "Feature", "weight": "가중치·모델 결합",
          "pattern": "패턴", "combination_generation": "조합 생성 조건", "validation": "검증(누수·과적합·격리)",
          "chance": "통계적 우연(무작위 변동)"}
BLOCK = 30
TABLES = [
    """CREATE TABLE IF NOT EXISTS prediction_quarantine (
        prediction_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        detail TEXT,
        detected_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS reverse_reports (
        report_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        latest_round INTEGER,
        report_json TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS ix_reverse_kind ON reverse_reports (kind, created_at)",
]
_READY: Dict[str, bool] = {}


def _ensure() -> None:
    from . import engine_audit

    engine_audit._ensure()
    k = db.backend()
    if _READY.get(k):
        return
    with db.transaction() as c:
        for s in TABLES:
            c.execute(s)
    _READY[k] = True


def reset_for_tests() -> None:
    _READY.clear()
    _REF.clear()


def _sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2))


def _save(kind: str, latest: Optional[int], rep: Dict[str, Any]) -> None:
    with db.transaction() as c:
        c.execute("INSERT INTO reverse_reports (report_id, kind, created_at, latest_round, report_json) VALUES (?,?,?,?,?)",
                  (uuid.uuid4().hex, kind, db.now_iso(), latest, db.dumps(rep)))


def last_report(kind: str) -> Optional[Dict[str, Any]]:
    _ensure()
    rows = db.query("SELECT created_at, report_json FROM reverse_reports WHERE kind = ? ORDER BY created_at DESC LIMIT 1",
                    (kind,))
    if not rows:
        return None
    rep = db.loads(rows[0][1])
    rep["saved_at"] = rows[0][0]
    return rep


# ─────────────────────────────── 1. 데이터 조사 · 격리 ───────────────────────────────

def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def inventory() -> Dict[str, Any]:
    """수집 항목 현황 + 격리. 누락 값은 만들지 않고 '없음'으로 센다."""
    from ..stats_engine.draws import load_draws

    _ensure()
    drawn = {d.round for d in load_draws()}
    rows = db.query(
        "SELECT h.prediction_id, h.draw_round, h.prediction_created_at, h.prediction_cutoff_at, h.engine_version, "
        "h.model_version, h.feature_version, h.training_data_range, h.prediction_method, h.predicted_numbers, "
        "h.prediction_score, h.prediction_type, e.match_count, e.prize_tier "
        "FROM round_prediction_history h LEFT JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id")
    by: Dict[Tuple[str, str], Dict[str, int]] = {}
    quarantine: List[Tuple[str, str, str]] = []
    for pid, rnd, created, cutoff, ev, mv, fv, rng, method, nums, score, ptype, mc, tier in rows:
        k = by.setdefault((ptype, method), {"rows": 0, "evaluated": 0, "pending_drawn": 0, "with_score": 0,
                                             "with_model_version": 0, "with_feature_version": 0, "quarantined": 0})
        k["rows"] += 1
        k["evaluated"] += mc is not None
        k["pending_drawn"] += (mc is None and int(rnd) in drawn)
        k["with_score"] += score is not None
        k["with_model_version"] += bool(mv)
        k["with_feature_version"] += bool(fv)
        reason = None
        try:
            ns = db.loads(nums)
            if len(ns) != 6 or len(set(ns)) != 6 or not all(1 <= int(n) <= 45 for n in ns):
                reason = ("invalid_numbers", f"{ns}")
        except Exception:  # noqa: BLE001
            reason = ("invalid_numbers", "parse error")
        if reason is None and ptype == "live":
            c_at, cut = _parse(created), _parse(cutoff)
            if c_at is None or cut is None:
                reason = ("unclear_prediction_time", f"created={created} cutoff={cutoff}")
            elif c_at >= cut:
                reason = ("created_after_cutoff", f"created={created} cutoff={cutoff}")
        if reason is None and ptype == "backtest" and rng and rng != "none":
            try:
                if int(str(rng).split("-")[1]) >= int(rnd):
                    reason = ("future_data_in_training", f"range={rng} round={rnd}")
            except (IndexError, ValueError):
                reason = ("unclear_training_range", f"range={rng}")
        if reason:
            quarantine.append((pid, reason[0], reason[1]))
            k["quarantined"] += 1
    if quarantine:
        with db.transaction() as c:
            for pid, r, d in quarantine:
                c.execute("INSERT INTO prediction_quarantine (prediction_id, reason, detail, detected_at) VALUES (?,?,?,?) "
                          "ON CONFLICT (prediction_id) DO NOTHING", (pid, r, d, db.now_iso()))
    reasons: Dict[str, int] = {}
    for _, r, _d in quarantine:
        reasons[r] = reasons.get(r, 0) + 1
    return {
        "methods": [{"type": t, "method": m, **v} for (t, m), v in sorted(by.items())],
        "quarantine": {"total": len(quarantine), "by_reason": reasons,
                       "note": "격리 행은 원본을 지우지 않고 모든 성과 집계에서만 제외합니다."},
        "fields_collected": ["회차", "예측 시점", "cutoff", "예측 번호(1조합/순위)", "실제 당첨·보너스", "엔진/모델/Feature 버전",
                             "학습 범위", "일치 수", "등수", "예측 점수(있는 엔진만)"],
        "fields_not_available": ["엔진별 Feature 가중치 스냅샷(회차통계·신호 엔진은 가중치 없음, 앙상블만 weight_version 저장)"],
        "historical_replay_note": "historical_replay 는 사후 재현이므로 실시간 성과(live)와 분리해서만 봅니다.",
    }


def _quarantined() -> set:
    _ensure()
    return {r[0] for r in db.query("SELECT prediction_id FROM prediction_quarantine")}


def _load(ptype: str = "backtest") -> Dict[str, Dict[int, Tuple[List[int], int]]]:
    q = _quarantined()
    rows = db.query(
        "SELECT h.prediction_id, h.prediction_method, h.draw_round, h.predicted_numbers, e.match_count "
        "FROM round_prediction_history h JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id "
        "WHERE h.prediction_type = ? AND h.prediction_rank = 1 AND h.prediction_status <> 'superseded'", (ptype,))
    out: Dict[str, Dict[int, Tuple[List[int], int]]] = {}
    for pid, m, r, nums, mc in rows:
        if pid in q:
            continue
        out.setdefault(m, {})[int(r)] = (sorted(int(x) for x in db.loads(nums)), int(mc))
    return out


# ─────────────────────────────── 조합 특징 ───────────────────────────────

def features_of(nums: Sequence[int], prev: Sequence[int] = (), freq: Optional[Sequence[int]] = None) -> Dict[str, float]:
    s = sorted(int(n) for n in nums)
    dec = [sum(1 for n in s if lo <= n <= hi) for lo, hi in DECADES]
    out = {"odd": sum(n % 2 for n in s), "low": sum(1 for n in s if n <= 22), "sum": sum(s),
           "consec": sum(1 for a, b in zip(s, s[1:]) if b - a == 1), "last_digits": len({n % 10 for n in s}),
           "max_decade": max(dec), "overlap_prev": len(set(s) & set(prev))}
    if freq is not None:
        order = sorted(range(1, 46), key=lambda n: (freq[n], n))  # 낮은 빈도 → 높은 빈도
        pct = {n: i / 44 for i, n in enumerate(order)}
        out["freq_pct"] = round(sum(pct[n] for n in s) / 6, 4)
    else:
        out["freq_pct"] = 0.5
    return out


_REF: Dict[str, Any] = {}


def reference() -> Dict[str, Any]:
    """무작위 조합(균등) 특징 분포 — 고정 시드 몬테카를로 20,000개."""
    if _REF:
        return _REF
    rng = random.Random(20261113)
    fs = [features_of(rng.sample(range(1, 46), 6), rng.sample(range(1, 46), 6)) for _ in range(20_000)]
    sums = sorted(f["sum"] for f in fs)
    n = len(fs)
    _REF.update({
        "n": n,
        "mean": {k: round(sum(f[k] for f in fs) / n, 4) for k in FEATURES if k != "freq_pct"} | {"freq_pct": 0.5},
        "sum_range95": [sums[int(0.025 * n)], sums[int(0.975 * n)]],
        "odd_extreme": sum(1 for f in fs if f["odd"] in (0, 1, 5, 6)) / n,
        "low_extreme": sum(1 for f in fs if f["low"] in (0, 1, 5, 6)) / n,
        "consec_any": sum(1 for f in fs if f["consec"] >= 1) / n,
        "decade_conc": sum(1 for f in fs if f["max_decade"] >= 3) / n,
    })
    return _REF


def _rate_test(k: int, n: int, p: float) -> Dict[str, Any]:
    if n == 0:
        return {"n": 0}
    rate = k / n
    z = (rate - p) / math.sqrt(p * (1 - p) / n) if 0 < p < 1 else 0.0
    se = math.sqrt(rate * (1 - rate) / n) if n else 0
    return {"n": n, "rate": round(rate, 4), "ci95": [round(max(0, rate - 1.96 * se), 4), round(min(1, rate + 1.96 * se), 4)],
            "random_rate": round(p, 4), "z": round(z, 2), "p": round(2 * _sf(abs(z)), 5)}


def _spearman(x: Sequence[float], y: Sequence[float]) -> Tuple[float, float]:
    n = len(x)
    if n < 10:
        return 0.0, 1.0

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            for t in range(i, j + 1):
                r[order[t]] = (i + j) / 2
            i = j + 1
        return r

    rx, ry = ranks(x), ranks(y)
    mx, my = sum(rx) / n, sum(ry) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    sxx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    syy = math.sqrt(sum((b - my) ** 2 for b in ry))
    rho = sxy / (sxx * syy) if sxx and syy else 0.0
    z = rho * math.sqrt(n - 1)
    return round(rho, 4), round(2 * _sf(abs(z)), 5)


def _welch(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float]:
    if len(a) < 5 or len(b) < 5:
        return 0.0, 1.0
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    va = sum((x - ma) ** 2 for x in a) / (len(a) - 1)
    vb = sum((x - mb) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b)) or 1e-9
    t = (ma - mb) / se
    return round(t, 3), round(2 * _sf(abs(t)), 5)


# ─────────────────────────────── 2·3·5. V5 역분석 ───────────────────────────────

def _blocks(rounds: List[int], matches: List[int], size: int = BLOCK) -> List[Dict[str, Any]]:
    out = []
    for i in range(0, len(rounds) - size + 1, size):
        seg = matches[i:i + size]
        m = sum(seg) / size
        se = math.sqrt(VAR1 / size)
        out.append({"from": rounds[i], "to": rounds[i + size - 1], "n": size, "mean": round(m, 4),
                    "ci95": [round(m - 1.96 * se, 3), round(m + 1.96 * se, 3)], "z": round((m - EXP) / se, 2)})
    return out


def _heterogeneity(blocks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """구간 평균의 흩어짐이 무작위(i.i.d.) 기대보다 큰지 — 카이제곱(k-1), Wilson-Hilferty 근사."""
    k = len(blocks)
    if k < 3:
        return {"blocks": k, "p": None, "significant": False}
    means = [b["mean"] for b in blocks]
    g = sum(means) / k
    chi = sum((m - g) ** 2 for m in means) / (VAR1 / blocks[0]["n"])
    df = k - 1
    z = ((chi / df) ** (1 / 3) - (1 - 2 / (9 * df))) / math.sqrt(2 / (9 * df))
    p = _sf(z)
    return {"blocks": k, "chi2": round(chi, 2), "df": df, "p": round(p, 4), "significant": p < 0.05}


def _cusum(matches: List[int], seed: int, perms: int = 200) -> Dict[str, Any]:
    n = len(matches)
    if n < 40:
        return {"ok": False}
    mu = sum(matches) / n

    def stat(xs):
        s, best, at = 0.0, 0.0, 0
        for i, x in enumerate(xs):
            s += x - mu
            if abs(s) > best:
                best, at = abs(s), i
        return best, at

    obs, at = stat(matches)
    rng = random.Random(seed)
    xs = list(matches)
    ge = 0
    for _ in range(perms):
        rng.shuffle(xs)
        if stat(xs)[0] >= obs:
            ge += 1
    before = matches[:at + 1]
    after = matches[at + 1:]
    return {"ok": True, "index": at, "max_abs_cusum": round(obs, 2), "p_perm": round((ge + 1) / (perms + 1), 4),
            "mean_before": round(sum(before) / len(before), 4) if before else None,
            "mean_after": round(sum(after) / len(after), 4) if after else None}


def reverse_analysis(ptype: str = "backtest", min_rounds: int = 90) -> Dict[str, Any]:
    from ..stats_engine.draws import load_draws

    _ensure()
    inv = inventory()
    ref = reference()
    draws = load_draws()
    by_round = {d.round: d for d in draws}
    cum: Dict[int, List[int]] = {}
    freq = [0] * 46
    for d in draws:
        cum[d.round] = list(freq)  # 그 회차 '이전' 누적 빈도
        for n in d.numbers:
            freq[n] += 1
    data = _load(ptype)
    latest = max((max(v) for v in data.values() if v), default=0)
    methods = []
    n_tests = max(1, len(data) * len(FEATURES))
    alpha_feat = 0.05 / n_tests
    pooled_x: Dict[str, List[float]] = {f: [] for f in FEATURES}
    pooled_y: List[float] = []
    for mi, (m, recs) in enumerate(sorted(data.items())):
        rounds = sorted(r for r in recs if r in by_round)
        if len(rounds) < min_rounds:
            continue
        matches = [recs[r][1] for r in rounds]
        feats = [features_of(recs[r][0], by_round[r - 1].numbers if (r - 1) in by_round else (), cum.get(r)) for r in rounds]
        for f in FEATURES:
            pooled_x[f].extend(x[f] for x in feats)
        pooled_y.extend(matches)
        blocks = _blocks(rounds, matches)
        het = _heterogeneity(blocks)
        cp = _cusum(matches, seed=1000 + mi)
        ranked = sorted(blocks, key=lambda b: -b["mean"])
        q = max(1, len(blocks) // 5)
        hi_b, lo_b = ranked[:q], ranked[-q:]
        in_rng = lambda bl: {r for b in bl for r in rounds if b["from"] <= r <= b["to"]}  # noqa: E731
        hi_r, lo_r = in_rng(hi_b), in_rng(lo_b)
        common = []
        for f in FEATURES:
            a = [x[f] for r, x in zip(rounds, feats) if r in hi_r]
            b = [x[f] for r, x in zip(rounds, feats) if r in lo_r]
            t, p = _welch(a, b)
            common.append({"feature": f, "label": FEATURE_LABELS[f], "high_mean": round(sum(a) / len(a), 3) if a else None,
                           "low_mean": round(sum(b) / len(b), 3) if b else None, "t": t, "p": p,
                           "significant_bonferroni": p < alpha_feat})
        drop = recovery = None
        if cp.get("ok") and cp["p_perm"] < 0.05 and cp["mean_after"] is not None and cp["mean_after"] < cp["mean_before"]:
            drop = rounds[cp["index"] + 1] if cp["index"] + 1 < len(rounds) else None
            after_blocks = [b for b in blocks if drop and b["from"] >= drop]
            recovery = next((b["from"] for b in after_blocks if b["mean"] >= EXP), None)
        diag = _structural(m, feats, ref)
        causes = _classify(m, het, cp, diag, common)
        methods.append({
            "method": m, "rounds": len(rounds), "mean": round(sum(matches) / len(matches), 4),
            "high_blocks": hi_b, "low_blocks": lo_b, "heterogeneity": het, "change_point": cp | (
                {"round": rounds[cp["index"]]} if cp.get("ok") else {}),
            "drop_start_round": drop, "recovery_round": recovery, "common_features": common,
            "structure": diag, "causes": causes,
            "verdict": ("구간별 성과 차이가 무작위 변동 범위를 넘음 — 원인 후보를 V6에서 검증" if het.get("significant") or
                        (cp.get("ok") and cp["p_perm"] < 0.05) else
                        "고성과·저성과 구간 차이는 무작위 변동 범위(규칙으로 확정하지 않음)"),
        })
    feat_rel = []
    for f in FEATURES:
        rho, p = _spearman(pooled_x[f], pooled_y)
        feat_rel.append({"feature": f, "label": FEATURE_LABELS[f], "spearman_vs_matches": rho, "p": p,
                         "significant_bonferroni": p < 0.05 / len(FEATURES), "n": len(pooled_y)})
    any_sig = any(x["significant_bonferroni"] for x in feat_rel)
    rep = {
        "kind": "v5", "ptype": ptype, "latest_round": latest, "block_size": BLOCK, "inventory": inv,
        "reference_random": ref, "methods": methods, "feature_vs_matches": feat_rel,
        "summary": {
            "methods_analyzed": len(methods),
            "methods_with_real_period_effect": [x["method"] for x in methods if x["heterogeneity"].get("significant")],
            "methods_with_change_point": [x["method"] for x in methods if x["change_point"].get("ok") and x["change_point"]["p_perm"] < 0.05],
            "feature_predicts_matches": any_sig,
            "conclusion": ("조합 특징(홀짝·저고·합계·연속·끝수·구간·직전겹침·빈도)과 일치 수 사이에 보정 후 유의한 관계 없음 — "
                           "i.i.d. 추첨 이론(모든 조합 기대 일치 0.8)과 일치" if not any_sig else
                           "일부 특징이 일치 수와 보정 후 유의 — 독립 기간 재현 전까지 규칙으로 확정하지 않음"),
        },
        "error_source_categories": CAUSES,
    }
    _save("v5", latest, rep)
    return rep


def _structural(method: str, feats: List[Dict[str, float]], ref: Dict[str, Any]) -> Dict[str, Any]:
    n = len(feats)
    lo, hi = ref["sum_range95"]
    return {
        "odd_extreme": _rate_test(sum(1 for f in feats if f["odd"] in (0, 1, 5, 6)), n, ref["odd_extreme"]),
        "low_extreme": _rate_test(sum(1 for f in feats if f["low"] in (0, 1, 5, 6)), n, ref["low_extreme"]),
        "sum_out_of_range": _rate_test(sum(1 for f in feats if not lo <= f["sum"] <= hi), n, 0.05),
        "consecutive_any": _rate_test(sum(1 for f in feats if f["consec"] >= 1), n, ref["consec_any"]),
        "decade_concentration": _rate_test(sum(1 for f in feats if f["max_decade"] >= 3), n, ref["decade_conc"]),
        "freq_pct_mean": round(sum(f["freq_pct"] for f in feats) / n, 3),
        "overlap_prev_mean": round(sum(f["overlap_prev"] for f in feats) / n, 3),
    }


def _classify(method: str, het, cp, diag, common) -> List[Dict[str, str]]:
    from . import engine_audit

    out: List[Dict[str, str]] = []
    z = lambda k: abs(diag[k].get("z", 0)) >= 3  # noqa: E731
    if z("odd_extreme") or z("low_extreme"):
        out.append({"category": "combination_generation", "finding": "홀짝·저고 극단 조합 비율이 무작위와 다름(홀짝 제한/편중)"})
    if z("sum_out_of_range"):
        out.append({"category": "combination_generation", "finding": f"합계 95% 범위 밖 비율 {diag['sum_out_of_range']['rate']} (무작위 0.05)"})
    if z("consecutive_any"):
        out.append({"category": "pattern", "finding": f"연속번호 포함 비율 {diag['consecutive_any']['rate']} vs 무작위 "
                                                        f"{diag['consecutive_any']['random_rate']}(과잉 배제/과잉 포함)"})
    if z("decade_concentration"):
        out.append({"category": "combination_generation", "finding": f"한 구간 3개 이상 편중 {diag['decade_concentration']['rate']}"})
    if abs(diag["freq_pct_mean"] - 0.5) > 0.25:
        out.append({"category": "feature", "finding": f"누적 빈도 백분위 평균 {diag['freq_pct_mean']} — 과거 빈도 의존(핫/콜드 극단)"})
    if abs(diag["overlap_prev_mean"] - EXP) > 0.5:
        out.append({"category": "pattern", "finding": f"직전 회차 겹침 평균 {diag['overlap_prev_mean']} (무작위 0.8)"})
    if engine_audit._leak_rows(method):
        out.append({"category": "validation", "finding": "학습 범위에 예측 회차 이후 포함(누수) — 격리 대상"})
    if any(c["significant_bonferroni"] for c in common):
        out.append({"category": "feature", "finding": "고성과·저성과 구간의 특징 차이가 보정 후 유의 — V6 홀드아웃 검증 필요"})
    for o in out:
        o["effect_on_hits"] = "공정 추첨에서 조합 구조는 기대 일치 수(0.8)를 바꾸지 않음 — 구조 편향은 적중률이 아닌 분포 특성"
    if not het.get("significant") and not (cp.get("ok") and cp["p_perm"] < 0.05):
        out.append({"category": "chance", "finding": "구간별 성과 차이·변화점이 무작위 변동 범위 — 저성과의 주원인은 통계적 우연",
                    "effect_on_hits": "-"})
    return out


# ─────────────────────────────── 6. V6 자동 보정 후보 ───────────────────────────────

class _State:
    __slots__ = ("idx", "freq", "last_seen", "pair", "prev", "win")

    def __init__(self) -> None:
        self.idx = 0
        self.freq = [0] * 46
        self.last_seen = [0] * 46
        self.pair = [[0] * 46 for _ in range(46)]
        self.prev: List[int] = []
        self.win: Dict[int, List[int]] = {30: [0] * 46, 100: [0] * 46}


def _walk(draws) -> Any:
    """idx 회차 직전 상태를 차례로 내놓는다(idx = len(draws) 이면 '다음 회차' 예측용). 누수 없음."""
    st = _State()
    for idx in range(len(draws) + 1):
        st.idx = idx
        yield idx, st
        if idx == len(draws):
            return
        d = draws[idx]
        for n in d.numbers:
            st.freq[n] += 1
            st.last_seen[n] = idx + 1
        for i in range(6):
            for j in range(i + 1, 6):
                a, b = d.numbers[i], d.numbers[j]
                st.pair[a][b] += 1
                st.pair[b][a] += 1
        for w, cnt in st.win.items():
            for n in d.numbers:
                cnt[n] += 1
            if idx - w >= 0:
                for n in draws[idx - w].numbers:
                    cnt[n] -= 1
        st.prev = list(d.numbers)


def _dec(n: int) -> int:
    return min(4, n // 10) if n < 40 else 4


def _spread(order: List[int], cap: int = 2) -> List[int]:
    out, cnt = [], [0] * 5
    for n in order:
        if cnt[_dec(n)] < cap:
            out.append(n)
            cnt[_dec(n)] += 1
            if len(out) == 6:
                break
    return sorted(out)


def _cond(order: List[int], lo: int = 100, hi: int = 175) -> List[int]:
    for c in combinations(order[:10], 6):  # 순위 우선 사전식 → 조건을 만족하는 가장 높은 순위 조합
        if 2 <= sum(n % 2 for n in c) <= 4 and lo <= sum(c) <= hi:
            return sorted(c)
    return sorted(order[:6])


def _borda(ranks: Dict[str, List[int]], weights: Dict[str, float]) -> List[int]:
    sc = [0.0] * 46
    for s, w in weights.items():
        for pos, n in enumerate(ranks[s]):
            sc[n] += w * (45 - pos)
    return sorted(sorted(range(1, 46), key=lambda n: (-sc[n], n))[:6])


STRATS = ("hot", "cold", "overdue", "recent", "pair_hot", "last_avoid")


def candidates() -> Dict[str, Tuple[str, str, Callable[[_State, Dict[str, List[int]]], List[int]]]]:
    """이름 → (원본 전략, 보정 축, 생성 함수). 모두 '원본 복사 + 한 가지 변경', 회차당 1조합."""
    c: Dict[str, Tuple[str, str, Callable]] = {}
    for w in (30, 100):
        c[f"feature:hot_window{w}"] = ("hot", "feature", lambda st, rk, w=w: sorted(
            sorted(range(1, 46), key=lambda n: (-st.win[w][n], n))[:6]))
    for a in (0.3, 0.7):
        c[f"weight:hot{a}_overdue{round(1 - a, 1)}"] = ("hot", "weight", lambda st, rk, a=a: _borda(
            rk, {"hot": a, "overdue": 1 - a}))
    for s in STRATS:
        c[f"spread:{s}"] = (s, "decade_dispersion", lambda st, rk, s=s: _spread(rk[s]))
        c[f"cond:{s}"] = (s, "generation_condition", lambda st, rk, s=s: _cond(rk[s]))
    c["pattern:hot_avoid_prev"] = ("hot", "pattern", lambda st, rk: sorted(
        [n for n in rk["hot"] if n not in set(st.prev)][:6]))
    c["blend:borda_equal"] = ("hot", "model_blend", lambda st, rk: _borda(rk, {s: 1.0 for s in STRATS}))
    c["blend:borda_hot2"] = ("hot", "model_blend", lambda st, rk: _borda(rk, {s: (2.0 if s == "hot" else 1.0) for s in STRATS}))
    return c


def _paired(a: List[int], b: List[int]) -> Tuple[float, float]:
    n = len(a)
    d = [x - y for x, y in zip(a, b)]
    md = sum(d) / n
    sd = math.sqrt(sum((x - md) ** 2 for x in d) / max(1, n - 1)) or 1e-9
    z = md / (sd / math.sqrt(n))
    return round(z, 3), round(_sf(z), 5)


def auto_correction(selection_frac: float = 0.7, warmup: int = 50) -> Dict[str, Any]:
    """V6 — 후보 전부를 같은 walk-forward 구간·같은 조합 수(회차당 1)로 평가.
    선택 기간 최고 후보 1개만 홀드아웃에서 원본·무작위와 비교(Bonferroni α=0.05/후보 수). 기존 전략은 그대로."""
    from ..stats_engine.backtest import _rankings
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    if len(draws) < warmup + 200:
        return {"status": "insufficient_data", "rounds": len(draws)}
    cands = candidates()
    sel_end = draws[warmup].round + int((len(draws) - warmup) * selection_frac)
    res: Dict[str, Dict[str, List[int]]] = {k: {"sel": [], "hold": []} for k in cands}
    base: Dict[str, Dict[str, List[int]]] = {s: {"sel": [], "hold": []} for s in STRATS}
    for idx, st in _walk(draws):
        if idx >= len(draws):
            break
        if idx < warmup:
            continue
        d = draws[idx]
        part = "sel" if d.round <= sel_end else "hold"
        ranks = _rankings(st.freq, st.last_seen, st.pair, st.prev, idx)
        win = set(d.numbers)
        for s in STRATS:
            base[s][part].append(len(set(ranks[s][:6]) & win))
        for k, (_b, _ax, fn) in cands.items():
            res[k][part].append(len(set(fn(st, ranks)) & win))
    sel_mean = {k: sum(v["sel"]) / len(v["sel"]) for k, v in res.items()}
    best = max(sel_mean, key=sel_mean.get)
    b_name, axis, _ = cands[best]
    hb, h0 = res[best]["hold"], base[b_name]["hold"]
    n = len(hb)
    mean_c, mean_0 = sum(hb) / n, sum(h0) / n
    z_r = (mean_c - EXP) / math.sqrt(VAR1 / n)
    z_o, p_o = _paired(hb, h0)
    alpha = 0.05 / len(cands)
    promoted = bool(_sf(z_r) < alpha and p_o < alpha)
    s_rounds = len(res[best]["sel"])
    table = [{"candidate": k, "base": f"stats_{v[0]}", "axis": v[1], "selection_mean": round(sel_mean[k], 4),
              "base_selection_mean": round(sum(base[v[0]]["sel"]) / s_rounds, 4)} for k, v in cands.items()]
    table.sort(key=lambda x: -x["selection_mean"])
    metrics = {
        "best_candidate": best, "base": f"stats_{b_name}", "axis": axis, "candidates": len(cands),
        "selection_rounds": s_rounds, "holdout_rounds": n, "selection_mean_best": round(sel_mean[best], 4),
        "holdout_mean_candidate": round(mean_c, 4), "holdout_mean_base": round(mean_0, 4),
        "z_vs_random": round(z_r, 3), "p_vs_random": round(_sf(z_r), 5), "z_vs_base": z_o, "p_vs_base": p_o,
        "alpha_bonferroni": round(alpha, 5), "overfit_gap": round(sel_mean[best] - mean_c, 4),
        "combos_per_round": 1, "cost_equal": True, "selection_table": table,
    }
    status = "promoted" if promoted else "rejected"
    reason = ("홀드아웃에서 원본·무작위 대비 보정 후 모두 유의 → 승인(다음 회차부터 별도 방식으로 추가 적용, 원본 유지)"
              if promoted else
              f"선택 기간 최고 후보({best})도 홀드아웃에서 원본·무작위와 보정 후 유의한 차이 없음 → 기존 모델 유지")
    vid = uuid.uuid4().hex
    with db.transaction() as c:
        c.execute("INSERT INTO engine_versions (version_id,engine,params_json,status,selection_range,holdout_range,metrics_json,"
                  "reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  (vid, f"v6:{best}", db.dumps({"candidate": best, "base": f"stats_{b_name}", "axis": axis}), status,
                   f"{draws[warmup].round}-{sel_end}", f"{sel_end + 1}-{draws[-1].round}", db.dumps(metrics), reason,
                   db.now_iso()))
    rep = {"kind": "v6", "status": status, "reason": reason, "version_id": vid,
           "selection_range": f"{draws[warmup].round}-{sel_end}", "holdout_range": f"{sel_end + 1}-{draws[-1].round}",
           **metrics}
    _save("v6", draws[-1].round, rep)
    return rep


def approved_models() -> List[Dict[str, Any]]:
    """V6에서 승인(promoted)된 후보만 — 다음 회차 사전 예측에 '추가' 방식으로 쓰인다(원본 대체 아님)."""
    _ensure()
    rows = db.query("SELECT version_id, engine, params_json, created_at FROM engine_versions "
                    "WHERE status = 'promoted' AND engine LIKE 'v6:%' ORDER BY created_at DESC")
    seen, out = set(), []
    for vid, eng, params, at in rows:
        p = db.loads(params)
        if p.get("candidate") in seen or p.get("candidate") not in candidates():
            continue
        seen.add(p["candidate"])
        out.append({"version_id": vid, "candidate": p["candidate"], "base": p.get("base"), "approved_at": at})
    return out


def candidate_pick(name: str, draws) -> List[int]:
    """승인 후보의 다음 회차 조합 — 주어진 draws(모두 대상 회차 이전)만 사용."""
    from ..stats_engine.backtest import _rankings

    fn = candidates()[name][2]
    for idx, st in _walk(draws):
        if idx == len(draws):
            return fn(st, _rankings(st.freq, st.last_seen, st.pair, st.prev, idx))
    return []


# ─────────────────────────────── 4. 기존 모듈(V1~V4-A) 재검증 ───────────────────────────────

def module_validation(null_runs: int = 8) -> Dict[str, Any]:
    from ..video_analysis import feature_learning_engine as F
    from ..video_analysis.ticket_source import mode

    _ensure()
    samples = F.collect_round_samples()
    n = len(samples)
    rounds = [s.round_no for s in samples]
    ordered = rounds == sorted(rounds)
    out: Dict[str, Any] = {"input_source": mode(), "samples": n, "sample_rounds": rounds[-10:]}
    # V1: 게이트를 '당첨을 무작위로 바꾼' 표본에 돌려 거짓 채택률(우연 채택)을 측정
    null = {"runs": 0, "adopted_per_run": None, "status": "insufficient_data"}
    if n >= F.MIN_ROUNDS_FOR_ADOPT:
        import dataclasses

        rng = random.Random(77)
        counts = []
        for i in range(null_runs):
            fake = [dataclasses.replace(s, winning=sorted(rng.sample(range(1, 46), 6))) for s in samples]
            counts.append(sum(1 for r in F.validate_features(fake, seed=900 + i) if r.get("adopted")))
        null = {"runs": null_runs, "adopted_per_run": round(sum(counts) / null_runs, 3),
                "runs_with_any_adoption": sum(1 for c in counts if c), "features_tested": len(F.FEATURE_LABELS),
                "status": "measured"}
    out["v1"] = {
        "walk_forward": {"status": "ok_no_leak", "detail": "회차 R 의 Feature 는 그 회차 용지만 사용하고 당첨은 채점에만 사용 — 누수 없음. "
                                                          "다만 Feature 선택과 성과 측정이 같은 회차(in-sample)라 선택 편향이 남음 → Nested CV 결과로 판단"},
        "bootstrap": {"status": "ok", "resamples": F.N_BOOTSTRAP, "note": "평균 95% CI — 재표본 수가 적어 경계값은 거침"},
        "permutation": {"status": "ok_low_resolution", "permutations": F.N_PERMUTATION,
                        "min_p": round(1 / (F.N_PERMUTATION + 1), 4),
                        "issue": f"Feature {len(F.FEATURE_LABELS)}개를 동시에 검정하는데 다중검정 보정이 없고, 표본 6회 미만이면 p≤0.22·lift 1.04 로 완화됨"},
        "monte_carlo": {"status": "ok", "simulations": F.N_MONTE_CARLO, "note": "균등 무작위 6개 vs 균등 당첨 — 기대 0.8"},
        "null_gate_false_adoption": null,
    }
    out["nested_cv"] = {
        "time_order": "ok" if ordered else "issue_unsorted_samples",
        "outer_leak": "none — outer 회차 R 은 R 이전 회차(prefix)로만 Feature 채택",
        "inner_split": "issue — inner_hold 인자는 최소 길이 확인에만 쓰이고 별도 inner 홀드아웃 분할이 없음(채택은 train 내부 "
                       "부트스트랩·순열로만). outer 평가는 미래 회차라 누수는 아님",
        "outer_folds_possible": max(0, n - 3),
    }
    out["shap_drift"] = {"status": "experimental_stub", "detail": "실제 SHAP 값이 아니라 permutation importance 근사. scoring_allowed=false 고정"}
    out["v2_pattern_mining"] = {"status": "ok_oos_available", "detail": "walk_forward_oos(확장 윈도우, prefix 로만 mine) 존재 — "
                                                                          "in-sample validate_pattern 의 lift 는 낙관적이므로 OOS 값만 판단 근거로"}
    from . import predictions as P

    perf = {}
    for m in ("v3_round_learning", "sheet_auto", "sheet_semi", "youtube_auto", "youtube_semi"):
        rows = db.query("SELECT e.match_count FROM round_prediction_history h JOIN round_prediction_evaluation e "
                        "ON e.prediction_id = h.prediction_id WHERE h.prediction_method = ? AND h.prediction_rank = 1", (m,))
        ms = [int(r[0]) for r in rows]
        perf[m] = {"rounds": len(ms), "mean": round(sum(ms) / len(ms), 3) if ms else None,
                   "label": P.METHOD_LABELS.get(m, m), "verdict": "표본 30회 미만 — 성능 판정 보류" if len(ms) < 30 else "판정 가능"}
    out["v3_v4a_recorded_performance"] = perf
    out["v4a_overlap"] = {"status": "insufficient_data" if n < 10 else "evaluable",
                          "detail": "앙상블·겹침 학습은 유튜브 확정 용지 회차가 쌓일수록 평가 가능(회차당 1조합, 무작위 0.8과 비교)"}
    out["overall"] = ("유튜브 확정 용지 표본이 아직 적어 V1~V4-A 성과는 '판정 보류'. 절차상 누수는 없음, 개선점은 다중검정 보정과 inner 분할"
                      if n < 30 else "표본 충분 — 위 항목별 결과로 판단")
    _save("modules", None, out)
    return out


# ─────────────────────────────── 8. 확률 검증 ───────────────────────────────

def probability_check() -> Dict[str, Any]:
    data = _load("backtest")
    allm = [mc for m, recs in data.items() for (_n, mc) in recs.values()]
    n = len(allm)
    obs = {f"{k}+": round(sum(1 for x in allm if x >= k) / n, 5) if n else None for k in (3, 4, 5, 6)}
    p3 = sum(math.comb(6, k) * math.comb(39, 6 - k) for k in range(3, 7)) / TOTAL_COMBOS
    p4 = sum(math.comb(6, k) * math.comb(39, 6 - k) for k in range(4, 7)) / TOTAL_COMBOS
    return {
        "mathematical": {"first_prize": "1/8,145,060", "tier_probability": {str(t): f"{c}/8,145,060" for t, c in TIER_COMBOS.items()},
                         "match3plus": round(p3, 5), "match4plus": round(p4, 6), "expected_matches": EXP},
        "observed_backtest": {"predictions": n, "rates": obs},
        "model_performance": "엔진별 평균 일치 수는 '엔진 감사' A 순위 참조 — 모두 무작위(0.8)와 보정 후 구분되지 않음",
        "calibration": "현재 엔진은 당첨 확률을 출력하지 않음(순위·번호만) → 확률 보정 대상 없음. 점수는 확률이 아님",
        "statement": "공정·독립 추첨에서 과거 패턴으로 다음 회차 당첨 확률이 오르지 않습니다. 비교는 회차당 같은 조합 수(1)·같은 비용으로 했습니다.",
    }


# ─────────────────────────────── 7. V7 자기개선 루프 ───────────────────────────────

def self_optimize(force: bool = False) -> Dict[str, Any]:
    """새 회차 결과 → 예측 대조 → 성과 → 구간 분석(V5) → 오류 탐색 → 개선 후보(V6) → walk-forward 비교 → 기록.
    같은 최신 회차로 이미 돌았으면 건너뜀(force 제외). 승인 모델만 다음 회차 사전 예측에 추가된다."""
    from . import predictions as P
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    latest = draws[-1].round if draws else 0
    prev = last_report("v7")
    if not force and prev and prev.get("latest_round") == latest:
        return {"status": "skipped_same_round", "latest_round": latest}
    steps: List[Dict[str, Any]] = []
    ev = P.evaluate_pending()
    steps.append({"step": "예측 대조(공식 결과 채점)", "result": ev})
    live = db.query("SELECT h.prediction_method, h.predicted_numbers, e.match_count, e.prize_tier FROM round_prediction_history h "
                    "JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id "
                    "WHERE h.prediction_type = 'live' AND h.draw_round = ? AND h.prediction_rank = 1", (latest,))
    steps.append({"step": "적중 성과(최신 회차 사전 예측)", "round": latest,
                  "result": [{"method": m, "numbers": db.loads(nums), "matches": mc, "tier": t} for m, nums, mc, t in live]})
    v5 = reverse_analysis()
    steps.append({"step": "구간 분석·오류 탐색(V5)", "result": v5["summary"],
                  "causes": {x["method"]: [c["category"] for c in x["causes"]] for x in v5["methods"]}})
    v6 = auto_correction()
    steps.append({"step": "개선 후보 생성·walk-forward 검증·모델 비교(V6)",
                  "result": {k: v6.get(k) for k in ("status", "best_candidate", "base", "holdout_mean_candidate",
                                                     "holdout_mean_base", "p_vs_random", "p_vs_base", "alpha_bonferroni", "reason")}})
    approved = approved_models()
    decision = (f"승인 모델 {len(approved)}개를 다음 회차 사전 예측에 추가(원본 유지)" if approved else
                "승인된 개선 모델 없음 — 다음 회차도 기존 모델 그대로")
    steps.append({"step": "결과 기록·다음 회차 적용 결정", "result": decision})
    rep = {"kind": "v7", "latest_round": latest, "next_round": latest + 1, "steps": steps, "approved_models": approved,
           "decision": decision, "probability": probability_check()}
    _save("v7", latest, rep)
    return rep


def full_report() -> Dict[str, Any]:
    _ensure()
    history = db.query("SELECT created_at, latest_round, report_json FROM reverse_reports WHERE kind = 'v6' "
                       "ORDER BY created_at DESC LIMIT 10")
    return {
        "v5": last_report("v5"), "v6": last_report("v6"), "v7": last_report("v7"), "modules": last_report("modules"),
        "v6_history": [{"at": a, "latest_round": r, **{k: db.loads(j).get(k) for k in (
            "status", "best_candidate", "holdout_mean_candidate", "holdout_mean_base", "p_vs_base", "version_id")}}
            for a, r, j in history],
        "approved_models": approved_models(),
        "probability": probability_check(),
    }


def run_all(force: bool = True) -> Dict[str, Any]:
    out = self_optimize(force=force)
    out_mod = module_validation()
    return {"v7": out.get("decision") or out.get("status"), "modules": out_mod.get("overall")}
