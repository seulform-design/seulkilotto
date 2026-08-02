"""SHAP / Feature Drift — Experimental 읽기 스텁 (점수 미연결).

artifacts/100_experimental/shap_drift.md
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from .explain import build_explain_payload
from .feature_learning_engine import FEATURE_LABELS, RoundSample, validate_features


SHAP_VERSION = "0.0.1-experimental"
HONESTY = (
    "Experimental SHAP/Drift 스텁. scoring_allowed=false 고정. "
    "permutation importance 근사만 제공. 당첨 확률 불변."
)


_SHAP_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
_SHAP_CACHE_MAX = 8
_SHAP_CACHE_TTL_SEC = 900  # 15분


def build_shap_drift_report(
    samples: Sequence[RoundSample],
    *,
    seed: int = 42,
) -> dict[str, Any]:
    import time
    from .store import store_signature
    from ..database import load_history

    df = load_history()
    latest_round = int(df["round"].max()) if (df is not None and not df.empty) else 0

    cache_key = (seed, latest_round, store_signature())
    now = time.monotonic()
    cached = _SHAP_CACHE.get(cache_key)
    if cached is not None and now - cached[0] < _SHAP_CACHE_TTL_SEC:
        return cached[1]

    res = _build_shap_drift_report_impl(samples, seed=seed)
    _SHAP_CACHE[cache_key] = (now, res)
    if len(_SHAP_CACHE) > _SHAP_CACHE_MAX:
        oldest = min(_SHAP_CACHE, key=lambda k: _SHAP_CACHE[k][0])
        _SHAP_CACHE.pop(oldest, None)
    return res


def _build_shap_drift_report_impl(
    samples: Sequence[RoundSample],
    *,
    seed: int = 42,
) -> dict[str, Any]:
    if not samples:
        explain = build_explain_payload(
            subject_type="signal",
            subject_value="shap_drift",
            decision="neutral",
            honesty=HONESTY,
            experimental=True,
            algorithms=["shap_stub"],
            limits=["표본 없음"],
            artifact_versions=["100_experimental/shap_drift"],
        )
        return {
            "ok": False,
            "version": SHAP_VERSION,
            "experimental": True,
            "scoring_allowed": False,
            "reason": "보관 회차 표본 없음",
            "shap": {"method": "planned", "values": {}, "baseline": None, "small_sample": True},
            "drift": {
                "metric": "mean_shift",
                "window": "n/a",
                "score": None,
                "alert": False,
            },
            "explain": explain,
            "honesty": HONESTY,
            "run_at": datetime.now(timezone.utc).isoformat(),
        }

    reports = validate_features(list(samples), seed=seed)
    # "shap values" ≈ (lift-1) * (1-p) 부호 있는 감사 점수 (추천 가중 아님)
    values: dict[str, float] = {}
    for r in reports:
        key = str(r.get("key") or "")
        lift = float(r.get("lift_vs_uniform") or 0.0)
        p = float(r.get("permutation_p") or 1.0)
        values[key] = round((lift - 1.0) * max(0.0, 1.0 - p), 4)

    # 단순 drift: early vs late walk_forward mean 차이 평균
    shifts = []
    for r in reports:
        ts = r.get("time_split") or {}
        early = float(ts.get("early_mean") or 0.0)
        late = float(ts.get("late_mean") or 0.0)
        shifts.append(abs(late - early))
    drift_score = round(float(sum(shifts) / len(shifts)), 4) if shifts else None

    explain = build_explain_payload(
        subject_type="signal",
        subject_value="shap_drift",
        decision="neutral",
        honesty=HONESTY,
        experimental=True,
        intent="current_round",
        rounds=[int(s.round_no) for s in samples],
        algorithms=["permutation_proxy", "time_split_drift"],
        evidence=[
            {
                "kind": "model",
                "detail": f"features={len(FEATURE_LABELS)} proxy_shap=lift×(1-p)",
                "weight": 0.5,
            },
            {
                "kind": "statistic",
                "detail": f"drift_mean_abs_shift={drift_score}",
                "weight": 0.4,
            },
        ],
        confidence={"overall": 0, "model": 0, "statistics": 0, "backtest": 0},
        backtest={
            "metric": "proxy_shap_count",
            "value": len(values),
            "baseline": None,
            "small_sample": len(samples) < 5,
        },
        limits=["Experimental", "SHAP 라이브러리 미사용 — proxy only", "점수 주입 금지"],
        improvements=["실 SHAP/Kernel 연동은 Validation 후", "PSI 드리프트"],
        artifact_versions=["100_experimental/shap_drift", "08_ai"],
    )

    return {
        "ok": True,
        "version": SHAP_VERSION,
        "experimental": True,
        "scoring_allowed": False,
        "model_id": "feature:ensemble_proxy",
        "shap": {
            "method": "permutation_proxy",
            "values": values,
            "baseline": 0.0,
            "small_sample": len(samples) < 5,
            "labels": {k: FEATURE_LABELS.get(k, k) for k in values},
        },
        "drift": {
            "metric": "mean_abs_early_late_shift",
            "window": "time_split_per_feature",
            "score": drift_score,
            "alert": bool(drift_score is not None and drift_score > 0.5),
        },
        "feature_reports_summary": [
            {
                "key": r.get("key"),
                "adopted": r.get("adopted"),
                "lift_vs_uniform": r.get("lift_vs_uniform"),
                "permutation_p": r.get("permutation_p"),
                "proxy_shap": values.get(str(r.get("key") or "")),
            }
            for r in reports
        ],
        "explain": explain,
        "honesty": HONESTY,
        "run_at": datetime.now(timezone.utc).isoformat(),
    }
