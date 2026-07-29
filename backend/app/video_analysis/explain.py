"""ExplainPayload builder — artifacts/10_explain/SCHEMA.md (0.1.0).

엔진별 honesty·백테스트 조각을 표준 필드로 묶는다. 확률을 올리지 않는다.
"""
from __future__ import annotations

from typing import Any


EXPLAIN_VERSION = "0.1.0"
DEFAULT_HONESTY = "확률 불변. 당첨 보장 없음. 1등 확률(1/8,145,060)은 변하지 않습니다."


def _confidence(
    overall: int = 0,
    statistics: int = 0,
    pattern: int = 0,
    model: int = 0,
    simulation: int = 0,
    backtest: int = 0,
) -> dict[str, int]:
    return {
        "overall": int(max(0, min(100, overall))),
        "statistics": int(max(0, min(100, statistics))),
        "pattern": int(max(0, min(100, pattern))),
        "model": int(max(0, min(100, model))),
        "simulation": int(max(0, min(100, simulation))),
        "backtest": int(max(0, min(100, backtest))),
    }


def build_explain_payload(
    *,
    subject_type: str,
    subject_value: Any = None,
    decision: str = "neutral",
    honesty: str | None = None,
    intent: str = "current_round",
    rounds: list[int] | None = None,
    algorithms: list[str] | None = None,
    evidence: list[dict[str, Any]] | None = None,
    confidence: dict[str, int] | None = None,
    backtest: dict[str, Any] | None = None,
    limits: list[str] | None = None,
    improvements: list[str] | None = None,
    artifact_versions: list[str] | None = None,
) -> dict[str, Any]:
    """Explain Artifact 표준 JSON."""
    conf = confidence or _confidence()
    # 누락 키 채움
    base = _confidence()
    base.update({k: int(v) for k, v in conf.items() if k in base})
    return {
        "version": EXPLAIN_VERSION,
        "subject": {"type": subject_type, "value": subject_value},
        "decision": decision,
        "confidence": base,
        "evidence": list(evidence or []),
        "used_data": {
            "intent": intent,
            "rounds": list(rounds or []),
            "artifact_versions": list(artifact_versions or []),
        },
        "algorithms": list(algorithms or []),
        "backtest": backtest
        or {"metric": "", "value": None, "baseline": None, "small_sample": True},
        "limits": list(limits or []),
        "improvements": list(improvements or []),
        "honesty": honesty or DEFAULT_HONESTY,
    }
