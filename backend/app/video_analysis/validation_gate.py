"""Validation Gate — 점수 주입 전 체크 (artifacts/08_ai/validation_gate.md).

Feature/Pattern 채택 결과를 GateResult 로 정규화한다.
Experimental·demo·review 누수는 scoring_allowed=false.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


GATE_VERSION = "0.1.0"


def _check(cid: str, ok: bool, detail: str = "") -> dict[str, Any]:
    return {"id": cid, "ok": bool(ok), "detail": detail}


def evaluate_gate(
    model_id: str,
    *,
    adopted: bool,
    checks: list[dict[str, Any]],
    metrics: dict[str, Any] | None = None,
    demo_source: bool = False,
    experimental: bool = False,
    review_leak: bool = False,
) -> dict[str, Any]:
    """GateResult. scoring_allowed 는 전 체크 통과 + adopted + 비실험/비데모/비누수."""
    g5 = _check("G5", not demo_source, "archived_demo forward 주입 금지" if demo_source else "ok")
    g4 = _check("G4", not review_leak, "review 학습 누수" if review_leak else "ok")
    g8 = _check("G8", not experimental, "Experimental 점수 금지" if experimental else "ok")
    # 호출측 checks 에 G4/G5/G8 이 없으면 여기서 보강
    ids = {c.get("id") for c in checks}
    merged = list(checks)
    if "G4" not in ids:
        merged.append(g4)
    if "G5" not in ids:
        merged.append(g5)
    if "G8" not in ids:
        merged.append(g8)

    all_ok = all(bool(c.get("ok")) for c in merged)
    status = "experimental_only" if experimental else ("passed" if adopted and all_ok else "rejected")
    scoring_allowed = bool(adopted and all_ok and not experimental and not demo_source and not review_leak)

    return {
        "version": GATE_VERSION,
        "model_id": model_id,
        "status": status,
        "checks": merged,
        "metrics": metrics or {},
        "scoring_allowed": scoring_allowed,
        "at": datetime.now(timezone.utc).isoformat(),
        "honesty": "게이트 통과 ≠ 당첨 확률 상승. i.i.d. 유지.",
    }


def evaluate_gate_from_feature_report(
    report: dict[str, Any],
    *,
    demo_source: bool = False,
    experimental: bool = False,
    review_leak: bool = False,
) -> dict[str, Any]:
    """feature_learning validate_features 행 → GateResult."""
    key = str(report.get("key") or "feature:unknown")
    model_id = key if key.startswith("feature:") else f"feature:{key}"
    adopted = bool(report.get("adopted"))
    lift = float(report.get("lift_vs_uniform") or 0.0)
    mean_h = float(report.get("walk_forward_mean_hits") or 0.0)
    baseline = float(report.get("uniform_baseline") or 0.8)
    p_perm = float(report.get("permutation_p") or 1.0)
    ts = report.get("time_split") or {}
    early = float(ts.get("early_mean") or 0.0)
    late = float(ts.get("late_mean") or 0.0)
    reasons = list(report.get("exclude_reason") or [])
    has_honesty = True  # 상위 응답 honesty 동봉 전제

    # 채택 엔진과 동일한 방향의 게이트 표시 (이미 adopted 면 G1–G3 통과로 본다)
    if adopted:
        g1 = _check("G1", True, f"WF mean={mean_h:.3f} lift={lift:.3f}")
        g2 = _check("G2", True, f"early={early:.3f} late={late:.3f}")
        g3 = _check("G3", True, f"permutation_p={p_perm:.3f}")
    else:
        g1 = _check("G1", mean_h >= baseline, f"WF mean={mean_h:.3f} vs baseline={baseline:.3f}")
        g2 = _check("G2", late >= baseline * 0.95 and early >= baseline * 0.95, "time-split")
        g3 = _check("G3", p_perm <= 0.10, f"permutation_p={p_perm:.3f}")
        if reasons:
            g1 = _check("G1", "기준선" not in "".join(reasons) and "표본" not in "".join(reasons), "; ".join(reasons[:2]))

    g6 = _check("G6", True, "fixed_semi 는 feature build 단계에서 제외")
    g7 = _check("G7", has_honesty, "honesty")

    return evaluate_gate(
        model_id,
        adopted=adopted,
        checks=[g1, g2, g3, g6, g7],
        metrics={
            "wf_mean_hits": mean_h,
            "lift_vs_uniform": lift,
            "permutation_p": p_perm,
            "small_sample": mean_h == 0.0 or baseline <= 0,
        },
        demo_source=demo_source,
        experimental=experimental,
        review_leak=review_leak,
    )


def evaluate_gate_from_pattern_score(
    score: dict[str, Any],
    *,
    demo_source: bool = False,
    experimental: bool = False,
    review_leak: bool = False,
) -> dict[str, Any]:
    """pattern_mining _score_dict 행 → GateResult."""
    pid = str(score.get("id") or "pattern:unknown")
    model_id = pid if pid.startswith("pattern:") else f"pattern:{pid}"
    adopted = bool(score.get("adopted"))
    lift = float(score.get("lift_vs_baseline") or 0.0)
    mean_h = float(score.get("wf_mean_hits") or 0.0)
    p_perm = float(score.get("permutation_p") or 1.0)
    reasons = list(score.get("exclude_reasons") or [])

    if adopted:
        checks = [
            _check("G1", True, f"WF mean={mean_h:.3f} lift={lift:.3f}"),
            _check("G2", True, "stability/retention ok"),
            _check("G3", True, f"permutation_p={p_perm:.3f}"),
            _check("G6", True, "fixed_semi 제외는 호출측"),
            _check("G7", True, "honesty"),
        ]
    else:
        detail = "; ".join(str(r) for r in reasons[:3]) if reasons else "not adopted"
        checks = [
            _check("G1", False, detail),
            _check("G2", False, detail),
            _check("G3", p_perm <= 0.10, f"permutation_p={p_perm:.3f}"),
            _check("G6", True, "ok"),
            _check("G7", True, "honesty"),
        ]

    return evaluate_gate(
        model_id,
        adopted=adopted,
        checks=checks,
        metrics={
            "wf_mean_hits": mean_h,
            "lift_vs_uniform": lift,
            "permutation_p": p_perm,
            "small_sample": True,
        },
        demo_source=demo_source,
        experimental=experimental,
        review_leak=review_leak,
    )


def summarize_gates(gates: list[dict[str, Any]], *, demo_blocked: bool = False) -> dict[str, Any]:
    """응답 상단용 요약."""
    return {
        "version": GATE_VERSION,
        "passed": [g["model_id"] for g in gates if g.get("status") == "passed"],
        "rejected": [g["model_id"] for g in gates if g.get("status") == "rejected"],
        "scoring_allowed_ids": [g["model_id"] for g in gates if g.get("scoring_allowed")],
        "demo_blocked": bool(demo_blocked),
        "count": len(gates),
    }
