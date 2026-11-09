"""공동선택 회피 점수의 실측 검증 — 공식 등수별 당첨자 수로 보정·검증한다.

구매자 개개인의 선택 데이터는 없다. 하지만 공식 결과에는 회차마다
- 판매액(→ 판매 게임 수 = 판매액 / 1,000원)
- 1등(6개 일치)·2등·3등 당첨자 수
가 공개된다. 균등 무작위 선택이라면 당첨 조합의 1등 당첨자 수 기대값은
  λ_r = 판매 게임 수 / 8,145,060
이다. 실제 당첨자 수 / λ_r = 그 당첨 조합의 '상대 인기도'(1 = 평균). 인기 조합일수록 크다.

검증: 회피 점수의 risk(인기도 위험)가 실제 상대 인기도와 양(+)의 순위상관을 가지는가?
(5등 같은 하위 등수는 당첨 조합의 부분집합 인기도라 신호가 약해 1·3등을 함께 본다.)

⚠️ kind = "measured_calibration": 공식 집계로 계산한 실측 검증 통계이며, 회피 점수 자체는
여전히 휴리스틱 추정치다. 1등 확률(1/8,145,060)과는 무관한 '기대수령액' 지표다.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

from . import coselection

TOTAL = 8_145_060


def ticket_price(round_no: int) -> int:
    """1게임 가격 — 2004년 8월(88회)부터 1,000원, 그 이전 2,000원."""
    return 2000 if int(round_no) < 88 else 1000


def _rank(xs: Sequence[float]) -> List[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def spearman(x: Sequence[float], y: Sequence[float]) -> Dict[str, Any]:
    n = len(x)
    if n < 10:
        return {"rho": None, "n": n, "p_value": None}
    rx, ry = _rank(x), _rank(y)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    sx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    sy = math.sqrt(sum((b - my) ** 2 for b in ry))
    rho = cov / (sx * sy) if sx and sy else 0.0
    # 대표본 근사: t = rho·sqrt((n-2)/(1-rho²)) → 정규 근사 양측 p
    t = rho * math.sqrt((n - 2) / max(1e-12, 1 - rho * rho))
    p = math.erfc(abs(t) / math.sqrt(2))
    lo = math.tanh(math.atanh(max(-0.999999, min(0.999999, rho))) - 1.96 / math.sqrt(n - 3))
    hi = math.tanh(math.atanh(max(-0.999999, min(0.999999, rho))) + 1.96 / math.sqrt(n - 3))
    return {"rho": round(rho, 4), "n": n, "p_value": round(p, 6), "ci95": [round(lo, 4), round(hi, 4)]}


def calibrate(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """rows: [{round, numbers, prizes:{'1':{'winners'}, '3':{...}, 'total_sales'}}]."""
    pts: List[Dict[str, Any]] = []
    for r in rows:
        pz = r.get("prizes") or {}
        sales = pz.get("total_sales")
        w1 = (pz.get("1") or {}).get("winners")
        w3 = (pz.get("3") or {}).get("winners")
        if not sales or w1 is None:
            continue
        games = float(sales) / ticket_price(r["round"])
        lam1 = games / TOTAL
        lam3 = games * (6 * 38) / TOTAL
        a = coselection.assess(r["numbers"])
        pts.append({"round": r["round"], "risk": a["risk"], "w1": int(w1), "lam1": lam1,
                    "rel1": int(w1) / lam1 if lam1 > 0 else None,
                    "rel3": (int(w3) / lam3) if (w3 is not None and lam3 > 0) else None})
    if len(pts) < 30:
        return {"ok": False, "kind": "measured_calibration", "reason": f"판매액·당첨자 데이터가 있는 회차 부족({len(pts)})"}
    pts.sort(key=lambda p: p["round"])
    risk = [p["risk"] for p in pts]
    rel1 = [p["rel1"] for p in pts]
    rel3 = [p["rel3"] for p in pts if p["rel3"] is not None]
    risk3 = [p["risk"] for p in pts if p["rel3"] is not None]
    # 위험도 구간별 실제 평균 상대 인기도(1등)
    bands = [(0, 30, "excellent"), (30, 45, "good"), (45, 62, "fair"), (62, 101, "poor")]
    by_band = []
    for lo, hi, g in bands:
        sel = [p for p in pts if lo <= p["risk"] < hi]
        if sel:
            obs = sum(p["w1"] for p in sel)
            exp = sum(p["lam1"] for p in sel)
            by_band.append({"grade": g, "rounds": len(sel), "observed_jackpot_winners": obs,
                            "expected_if_uniform": round(exp, 1), "relative_popularity": round(obs / exp, 3) if exp else None})
    s1 = spearman(risk, rel1)
    s3 = spearman(risk3, rel3)
    def _pos_sig(s: Dict[str, Any]) -> bool:
        return bool(s.get("rho") and s["rho"] > 0 and s.get("p_value") is not None and s["p_value"] < 0.05)

    v1, v3 = _pos_sig(s1), _pos_sig(s3)
    valid = v1 or v3
    return {
        "ok": True,
        "kind": "measured_calibration",
        "data_source": "동행복권 공식 회차별 판매액·등수별 당첨자 수(실측 집계)",
        "rounds": len(pts),
        "round_range": [pts[0]["round"], pts[-1]["round"]],
        "spearman_risk_vs_jackpot_popularity": s1,
        "spearman_risk_vs_rank3_popularity": s3,
        "by_grade": by_band,
        "score_validated": valid,
        "validated_on": [x for x, ok in (("rank1", v1), ("rank3", v3)) if ok],
        "confidence": ("medium" if (v1 and s1["rho"] >= 0.15) or (v3 and s3["rho"] >= 0.15) else "low"),
        "interpretation": (
            ("위험도가 높은 당첨 조합일수록 실제 당첨자가 균등 기대보다 많았습니다(양의 순위상관, p<0.05). "
             + ("1등 당첨자 수로도 확인됩니다." if v1 else
                "다만 1등 당첨자 수 단독으로는 회차별 잡음이 커서 유의하지 않고, 5개 일치(3등) 인기도로 확인됩니다.")
             + " 점수가 실제 공동선택 경향을 일부 반영한다는 실측 근거입니다(상관 크기는 약~중간).")
            if valid else
            "회피 점수의 위험도와 실제 1등 당첨자 수(상대 인기도) 사이에 유의한 양의 상관이 확인되지 않았습니다 — "
            "점수는 검증되지 않은 휴리스틱 추정치로만 사용하세요."
        ),
        "limits": [
            "개별 구매자 선택 데이터가 아니라 회차당 당첨 조합 1개의 집계만 관측됩니다(회차당 표본 1).",
            "1등 당첨자 수는 포아송 잡음이 커서 상관이 약하게 나올 수 있습니다.",
            "1등 확률(1/8,145,060)과 무관 — 당첨 시 분배 인원(기대수령액)에 관한 지표입니다.",
        ],
    }


def calibrate_from_registry() -> Dict[str, Any]:
    from ..ingest import db

    rows = db.query("SELECT round,n1,n2,n3,n4,n5,n6,prizes_json FROM reg_draws WHERE prizes_json IS NOT NULL")
    data = [{"round": r[0], "numbers": list(r[1:7]), "prizes": db.loads(r[7])} for r in rows]
    return calibrate(data)


_SUMMARY_CACHE: Dict[str, Any] = {}


def cached_summary(ttl_sec: float = 6 * 3600) -> Dict[str, Any]:
    """추천 응답에 붙일 짧은 검증 요약(6시간 캐시). 실패/데이터 없음이면 '추정치·미검증'."""
    import time as _t

    hit = _SUMMARY_CACHE.get("v")
    if hit and _t.time() - hit[0] < ttl_sec:
        return hit[1]
    try:
        r = calibrate_from_registry()
    except Exception as exc:  # noqa: BLE001
        r = {"ok": False, "reason": str(exc)[:200]}
    if r.get("ok"):
        s = {
            "kind": "measured_calibration",
            "data_source": r["data_source"],
            "rounds": r["rounds"],
            "validated": r["score_validated"],
            "validated_on": r.get("validated_on"),
            "confidence": r["confidence"],
            "rank3_spearman": r["spearman_risk_vs_rank3_popularity"].get("rho"),
            "rank1_spearman": r["spearman_risk_vs_jackpot_popularity"].get("rho"),
        }
    else:
        s = {"kind": "heuristic_estimate", "validated": False, "confidence": "unverified",
             "reason": r.get("reason") or "공식 당첨자 수 데이터 미수집"}
    _SUMMARY_CACHE["v"] = (_t.time(), s)
    return s
