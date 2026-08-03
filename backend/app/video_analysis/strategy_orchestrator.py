"""전략 폐기 오케스트레이터 — 제안만 (scoring 자동 변경 금지).

artifacts/09_validation/orchestration.md
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


ORCH_VERSION = "0.1.0"
HONESTY = "제안만. scoring_allowed 변경은 사람 확인 후. 당첨 확률 불변."


def propose_retirements(
    *,
    gate_summary: dict[str, Any] | None = None,
    ensemble_models: list[dict[str, Any]] | None = None,
    leaderboard: list[dict[str, Any]] | None = None,
    min_windows: int = 3,
) -> dict[str, Any]:
    """폐기·비활성 **후보** 목록. auto_applied 는 항상 False.

    - gate: rejected 이면서 한동안 재채택 없는 id → propose_disable
    - ensemble: stable=False 이고 selected 가 아닌 모델 → propose_disable
    - leaderboard: mean_top6 이 무작위 기대보다 낮고 표본 충분 → propose_review
    """
    from .model_registry_store import list_disabled_ids

    candidates: list[dict[str, Any]] = []
    unchanged: list[str] = []
    disabled = list_disabled_ids()

    gs = gate_summary or {}
    allowed = set(gs.get("scoring_allowed_ids") or [])
    for mid in gs.get("rejected") or []:
        if mid in allowed or mid in disabled:
            unchanged.append(mid)
            continue
        candidates.append(
            {
                "model_id": str(mid),
                "action": "propose_disable",
                "reason": "validation_gate rejected / scoring_allowed=false",
                "metrics": {},
                "requires_human": True,
                "auto_applied": False,
            }
        )
    for mid in allowed:
        unchanged.append(str(mid))

    for m in ensemble_models or []:
        name = str(m.get("name") or "")
        if not name:
            continue
        if m.get("stable"):
            unchanged.append(f"ensemble:{name}")
            continue
        candidates.append(
            {
                "model_id": f"ensemble:{name}",
                "action": "propose_disable",
                "reason": "ensemble model not stable",
                "metrics": {
                    "lift_vs_uniform": m.get("lift_vs_uniform"),
                    "walk_forward_mean_hits": m.get("walk_forward_mean_hits"),
                },
                "requires_human": True,
                "auto_applied": False,
            }
        )

    # leaderboard: 정보성 propose_review (자동 disable 아님)
    for row in leaderboard or []:
        key = str(row.get("key") or row.get("label") or "")
        if not key:
            continue
        mean6 = row.get("mean_top6")
        rounds = int(row.get("rounds") or row.get("n") or 0)
        if mean6 is None or rounds < min_windows:
            continue
        baseline = 6 * 6 / 45  # top6 pick ≈ 0.8 expected hits
        if float(mean6) + 1e-9 < baseline:
            candidates.append(
                {
                    "model_id": f"signal:{key}",
                    "action": "propose_review",
                    "reason": f"mean_top6={mean6} < uniform≈{round(baseline, 3)} over {rounds} rounds",
                    "metrics": {"mean_top6": mean6, "rounds": rounds, "baseline": baseline},
                    "requires_human": True,
                    "auto_applied": False,
                }
            )

    # 중복 model_id 제거 (첫 항목 유지)
    seen: set[str] = set()
    uniq: list[dict[str, Any]] = []
    for c in candidates:
        mid = c["model_id"]
        if mid in seen:
            continue
        seen.add(mid)
        uniq.append(c)

    return {
        "version": ORCH_VERSION,
        "run_at": datetime.now(timezone.utc).isoformat(),
        "candidates": uniq,
        "unchanged": sorted(set(unchanged)),
        "auto_mutate_scoring": False,
        "honesty": HONESTY,
    }
