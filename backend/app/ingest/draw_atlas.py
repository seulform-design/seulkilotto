"""당첨 패턴 아틀라스 — 전 회차 당첨 번호를 '1/8,145,060 공간'으로 역산해 DB 화한다.

무엇을 저장하나
--------------
- draw_pattern_atlas        : 회차별 당첨 조합의 사전식 순번(1 ~ 8,145,060), 패턴(합계·홀짝·저고·연속·AC·소수·구간·끝수),
                              그 패턴 클래스에 속한 조합 수와 정확한 확률, 전형도(typicality).
- pattern_exact_distribution: 패턴 값별 '정확한' 조합 수(8,145,060개 전수 — scripts/gen_pattern_exact.py)와
                              실제 당첨 횟수·기대 횟수(관측 vs 정확값).

정직성
------
모든 조합의 당첨 확률은 똑같이 1/8,145,060 이다. 흔한 패턴(예: 홀수 3개)은 그 패턴에 속한 '조합이 많아서' 자주
나올 뿐이며, 그 안의 한 조합이 더 잘 나오지 않는다. 그래서 패턴 필터로 1등 확률은 올라가지 않는다.
walk_forward() 는 '과거에 자주 나온 패턴 클래스'가 다음 회차를 정확 확률 이상으로 맞히는지 이전 회차만으로 검증한다.
"""
from __future__ import annotations

import json
import math
from collections import Counter
from functools import lru_cache
from itertools import combinations
from pathlib import Path
from typing import Any, Dict, List, Sequence

from . import db

TOTAL = 8145060
PRIMES = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43}
FEATURES = ["sum", "odd", "low", "consec", "ac", "prime", "decades_used", "decade_max", "last_digits"]
LABELS = {"sum": "합계", "odd": "홀수 개수", "low": "저번호(1~22) 개수", "consec": "연속쌍 수", "ac": "AC값(차이 다양성)",
          "prime": "소수 개수", "decades_used": "사용 구간 수(10단위)", "decade_max": "한 구간 최대 개수",
          "last_digits": "서로 다른 끝수 개수"}
TABLES = [
    """CREATE TABLE IF NOT EXISTS draw_pattern_atlas (
        draw_round INTEGER PRIMARY KEY,
        numbers TEXT NOT NULL,
        combo_index INTEGER NOT NULL,
        features TEXT NOT NULL,
        class_key INTEGER NOT NULL,
        class_combos INTEGER NOT NULL,
        class_prob REAL NOT NULL,
        typicality REAL NOT NULL,
        atlas_version TEXT NOT NULL,
        updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS pattern_exact_distribution (
        feature TEXT NOT NULL,
        value INTEGER NOT NULL,
        combos INTEGER NOT NULL,
        exact_prob REAL NOT NULL,
        observed INTEGER NOT NULL,
        expected REAL NOT NULL,
        rounds INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (feature, value))""",
]
_READY: Dict[str, bool] = {}


def _ensure() -> None:
    key = db.backend()
    if _READY.get(key):
        return
    with db.transaction() as c:
        for s in TABLES:
            c.execute(s)
    _READY[key] = True


def reset_for_tests() -> None:
    _READY.clear()


@lru_cache(maxsize=1)
def exact() -> Dict[str, Any]:
    return json.loads((Path(__file__).with_name("pattern_exact.json")).read_text(encoding="utf-8"))


def features(nums: Sequence[int]) -> Dict[str, int]:
    """gen_pattern_exact.features() 와 같은 정의."""
    c = sorted(int(x) for x in nums)
    d = [b - a for a, b in zip(c, c[1:])]
    dec = Counter(min((x - 1) // 10, 4) for x in c)
    s = sum(c)
    return {"sum": s, "odd": sum(x % 2 for x in c), "low": sum(x <= 22 for x in c), "consec": sum(x == 1 for x in d),
            "ac": len({b - a for a, b in combinations(c, 2)}) - 5, "prime": sum(x in PRIMES for x in c),
            "decades_used": len(dec), "decade_max": max(dec.values()), "last_digits": len({x % 10 for x in c}),
            "sum_bucket": min(max((s - 1) // 20, 3), 11)}


def class_key(f: Dict[str, int]) -> int:
    cons = min(f["consec"], 2)
    ac = min(max(f["ac"], 6), 10) - 6
    return (((f["odd"] * 7 + f["low"]) * 3 + cons) * 5 + ac) * 9 + (f["sum_bucket"] - 3)


def class_desc(f: Dict[str, int]) -> str:
    lo = f["sum_bucket"] * 20 + 1 if f["sum_bucket"] > 3 else 21
    hi = (f["sum_bucket"] + 1) * 20 if f["sum_bucket"] < 11 else 255
    cons = ["연속 없음", "연속쌍 1", "연속쌍 2+"][min(f["consec"], 2)]
    ac = "AC≤6" if f["ac"] <= 6 else f"AC {f['ac']}"
    return f"홀{f['odd']}·짝{6 - f['odd']} / 저{f['low']}·고{6 - f['low']} / {cons} / {ac} / 합 {lo}~{hi}"


def combo_index(nums: Sequence[int]) -> int:
    """사전식 순번: [1,2,3,4,5,6] = 1 … [40,41,42,43,44,45] = 8,145,060."""
    c = sorted(int(x) for x in nums)
    b = sorted(46 - x for x in c)  # 역순 매핑의 colex 순위 = 역사전식 순위
    colex = sum(math.comb(x - 1, i + 1) for i, x in enumerate(b))
    return TOTAL - colex


def pattern_of(nums: Sequence[int]) -> Dict[str, Any]:
    ex = exact()
    f = features(nums)
    k = class_key(f)
    n = int(ex["class_counts"].get(str(k), 0))
    return {"numbers": sorted(int(x) for x in nums), "combo_index": combo_index(nums), "features": f, "class_key": k,
            "class_desc": class_desc(f), "class_combos": n, "class_prob": n / TOTAL,
            "typicality": float(ex["typicality_by_size"].get(str(n), 0.0)), "each_combo_prob": "1/8,145,060",
            "feature_probs": {x: int(ex["dist"][x].get(str(f[x]), 0)) / TOTAL for x in FEATURES}}


def _chi2(obs: List[int], exp: List[float]) -> Dict[str, Any]:
    """기대 5 미만 칸은 이웃과 합친 카이제곱 적합도."""
    o2, e2, ao, ae = [], [], 0, 0.0
    for o, e in zip(obs, exp):
        ao += o
        ae += e
        if ae >= 5:
            o2.append(ao)
            e2.append(ae)
            ao, ae = 0, 0.0
    if ae and e2:
        o2[-1] += ao
        e2[-1] += ae
    stat = sum((o - e) ** 2 / e for o, e in zip(o2, e2))
    dof = max(len(o2) - 1, 1)
    try:
        from scipy.stats import chi2

        p = float(chi2.sf(stat, dof))
    except Exception:  # noqa: BLE001
        p = None
    return {"chi2": round(stat, 2), "dof": dof, "p": None if p is None else round(p, 4)}


def build(draws=None) -> Dict[str, Any]:
    """전 회차 아틀라스·정확 분포 테이블을 갱신(업서트 — 기존 행 삭제 없음)."""
    _ensure()
    if draws is None:
        from ..stats_engine.draws import load_draws

        draws = load_draws()
    ex = exact()
    now = db.now_iso()
    ver = ex["version"]
    obs = {x: Counter() for x in FEATURES}
    with db.transaction() as c:
        for d in draws:
            p = pattern_of(d.numbers)
            for x in FEATURES:
                obs[x][p["features"][x]] += 1
            c.execute("INSERT INTO draw_pattern_atlas (draw_round, numbers, combo_index, features, class_key, class_combos, "
                      "class_prob, typicality, atlas_version, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (draw_round) "
                      "DO UPDATE SET numbers=excluded.numbers, combo_index=excluded.combo_index, features=excluded.features, "
                      "class_key=excluded.class_key, class_combos=excluded.class_combos, class_prob=excluded.class_prob, "
                      "typicality=excluded.typicality, atlas_version=excluded.atlas_version, updated_at=excluded.updated_at",
                      (int(d.round), db.dumps(p["numbers"]), p["combo_index"], db.dumps(p["features"]), p["class_key"],
                       p["class_combos"], p["class_prob"], p["typicality"], ver, now))
        n = len(draws)
        for x in FEATURES:
            for v, cnt in ex["dist"][x].items():
                pr = cnt / TOTAL
                c.execute("INSERT INTO pattern_exact_distribution (feature, value, combos, exact_prob, observed, expected, rounds, "
                          "updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (feature, value) DO UPDATE SET combos=excluded.combos, "
                          "exact_prob=excluded.exact_prob, observed=excluded.observed, expected=excluded.expected, "
                          "rounds=excluded.rounds, updated_at=excluded.updated_at",
                          (x, int(v), int(cnt), pr, int(obs[x].get(int(v), 0)), pr * n, n, now))
    return {"rounds": len(draws), "version": ver}


def walk_forward(draws, first: int = 101, top_k: int = 100) -> Dict[str, Any]:
    """이전 회차에서 가장 자주 나온 패턴 클래스 top_k 를 고르고, 다음 회차 당첨 조합이 그 안에 들어가는 비율을
    그 클래스 집합의 '정확 확률(조합 수/8,145,060)'과 비교. 패턴 학습이 정확 확률 이상을 주면 관측 > 기대."""
    ex = exact()["class_counts"]
    seen: Counter = Counter()
    hit = 0
    expv = 0.0
    var = 0.0
    n = 0
    for i, d in enumerate(draws):
        k = class_key(features(d.numbers))
        if i >= first - 1 and seen:
            top = [c for c, _ in seen.most_common(top_k)]
            pm = sum(int(ex.get(str(c), 0)) for c in top) / TOTAL
            hit += k in set(top)
            expv += pm
            var += pm * (1 - pm)
            n += 1
        seen[k] += 1
    z = (hit - expv) / math.sqrt(var) if var else 0.0
    p = math.erfc(abs(z) / math.sqrt(2))
    return {"rounds": n, "top_k_classes": top_k, "observed_in_learned_classes": hit, "expected_by_exact_prob": round(expv, 1),
            "observed_rate": round(hit / n, 4) if n else None, "exact_rate": round(expv / n, 4) if n else None,
            "z": round(z, 2), "p_two_sided": round(p, 4),
            "verdict": ("과거 빈출 패턴 클래스가 정확 확률보다 더 자주 나온다는 증거 없음 — 패턴은 '조합 수'만큼 나온다."
                        if p >= 0.05 else "정확 확률과 차이가 있음(추가 검증 필요).")}


def set_ceiling() -> Dict[str, Any]:
    """10장 세트의 '1장 이상 5등+' 확률 한계. P(1장 이상) ≤ E[당첨 장수] = 10 × 0.023834 (겹침 0일 때 등호)."""
    from . import master_engine as M

    return {"version": M.WEIGHTS_VERSION, "current": M.COVER_EXACT["p_any_3plus"], "upper_bound": 0.238341,
            "w3_range": M.OVERLAP_REF["v12_w3_10combos_p_any_3plus"], "random_10": M.OVERLAP_REF["independent_random_10"],
            "exact_search_best": 0.230178,
            "note": ("8,145,060개 전수 목적함수로 번호 1개씩 바꾸는 국소 탐색 3,000회를 돌려도 23.018%(+0.009%p)에서 멈춰 "
                     "현재 설계가 사실상 국소 최적입니다. 6개 번호 조합 10장은 3개+ 일치가 서로 겹치는 경우를 0으로 만들 수 없어 "
                     "한계까지의 남은 여지는 0.8%p 이하입니다. 1등 확률(10/8,145,060)은 어떤 설계로도 바뀌지 않습니다.")}


def report() -> Dict[str, Any]:
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    have = db.query("SELECT COUNT(*) FROM draw_pattern_atlas")[0][0]
    if int(have or 0) != len(draws):
        build(draws)
    ex = exact()
    n = len(draws)
    rows = db.query("SELECT feature, value, combos, exact_prob, observed, expected FROM pattern_exact_distribution "
                    "ORDER BY feature, value")
    dist: Dict[str, Any] = {}
    for f, v, cb, pr, o, e in rows:
        dist.setdefault(f, {"label": LABELS.get(f, f), "rows": []})["rows"].append(
            {"value": int(v), "combos": int(cb), "exact_prob": float(pr), "observed": int(o), "expected": round(float(e), 1)})
    for f, d in dist.items():
        d["fit"] = _chi2([r["observed"] for r in d["rows"]], [r["expected"] for r in d["rows"]])
    pats = [pattern_of(d.numbers) | {"round": d.round} for d in draws]
    # 전형도가 무작위라면 0~1 균등 → 10분위별 회차 수가 n/10 근처
    deciles = Counter(min(int(p["typicality"] * 10), 9) for p in pats)
    typ = [deciles.get(i, 0) for i in range(10)]
    cls = Counter(p["class_key"] for p in pats)
    top_cls = []
    for k, cnt in cls.most_common(10):
        sample = next(p for p in pats if p["class_key"] == k)
        cb = int(ex["class_counts"].get(str(k), 0))
        top_cls.append({"class_key": k, "desc": sample["class_desc"], "observed": cnt, "combos": cb,
                        "exact_prob": cb / TOTAL, "expected": round(cb / TOTAL * n, 1)})
    idx = [p["combo_index"] for p in pats]
    return {
        "rounds": n, "range": f"{draws[0].round}~{draws[-1].round}회" if draws else "",
        "total_combos": TOTAL, "version": ex["version"], "classes_total": len(ex["class_counts"]),
        "distributions": dist,
        "typicality_deciles": {"counts": typ, "expected_each": round(n / 10, 1),
                               "fit": _chi2(typ, [n / 10] * 10)},
        "top_classes": top_cls,
        "combo_index_spread": {"min": min(idx), "max": max(idx), "mean": round(sum(idx) / n), "uniform_mean": (TOTAL + 1) // 2,
                               "halves": [sum(i <= TOTAL // 2 for i in idx), sum(i > TOTAL // 2 for i in idx)]} if idx else {},
        "repeats": {"distinct_winning_combos": len(set(idx)), "rounds": n},
        "recent": [{k: p[k] for k in ("round", "numbers", "combo_index", "class_desc", "class_combos", "class_prob", "typicality",
                                      "features")} for p in pats[-12:]][::-1],
        "walk_forward": walk_forward(draws),
        "set_ceiling": set_ceiling(),
        "honesty": ("모든 조합은 똑같이 1/8,145,060. 패턴 확률 = 그 패턴의 조합 수 ÷ 8,145,060 이며, 흔한 패턴은 조합이 많아서 "
                    "자주 나올 뿐 그 안의 한 조합이 더 잘 나오지 않는다. 바꿀 수 있는 것은 10장 세트의 '한 장이라도 맞을 확률'"
                    "(V12 통합 세트 설계)과 당첨 시 나눠 갖는 인원(인기 패턴 회피)뿐이다."),
    }
