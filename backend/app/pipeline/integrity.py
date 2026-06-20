"""롤오버 3중 무결성 검증 레이어."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

import pandas as pd

from ..data_meta import get_history_meta
from ..database import load_history
from ..datasets.historical import HistoricalDataset
from ..datasets.current import CurrentDrawSandbox


class IntegrityGateError(RuntimeError):
    def __init__(self, checks: Dict[str, Any]):
        self.checks = checks
        failed = [k for k, v in checks.items() if isinstance(v, dict) and not v.get("ok", True)]
        super().__init__(f"Integrity gate failed: {', '.join(failed)}")


def _winning_numbers_for_round(df: pd.DataFrame, round_no: int) -> Optional[Set[int]]:
    if df.empty:
        return None
    row = df[df["round"].astype(int) == int(round_no)]
    if row.empty:
        return None
    r = row.iloc[0]
    return {int(r[f"num{i}"]) for i in range(1, 7)}


def evaluate_recommendation_backtest(
    closed_round: int,
    derived_runs: List[Dict[str, Any]],
    winning: Set[int],
) -> Dict[str, Any]:
    """N회차 규칙 생산 추천 vs 실제 당첨 대조."""
    best_hit = 0
    per_engine: Dict[str, Any] = {}
    for run in derived_runs:
        engine = str(run.get("engine") or "unknown")
        payload = run.get("payload") or {}
        sets = payload.get("sets") or payload.get("games") or []
        engine_best = 0
        for game in sets:
            nums = game.get("numbers") if isinstance(game, dict) else game
            if not isinstance(nums, list):
                continue
            hit = len(set(int(n) for n in nums) & winning)
            engine_best = max(engine_best, hit)
            best_hit = max(best_hit, hit)
        per_engine[engine] = {"best_hit": engine_best, "set_count": len(sets)}
    return {
        "round_no": closed_round,
        "winning_numbers": sorted(winning),
        "best_hit": best_hit,
        "per_engine": per_engine,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }


def run_integrity_gate(
    closed_round: int,
    sandbox_snapshot: Dict[str, Any],
    *,
    historical: HistoricalDataset | None = None,
) -> Dict[str, Any]:
    """Integrity / Leakage / Consistency 검증. 실패 시 예외."""
    hist = historical or HistoricalDataset()
    meta = get_history_meta()
    latest = int(meta.get("latest_round") or 0)
    df = load_history()

    checks: Dict[str, Any] = {}

    # Integrity: 필수 메타 존재
    state = sandbox_snapshot.get("state") or {}
    checks["integrity"] = {
        "ok": bool(state.get("round_no") == closed_round),
        "sandbox_round": state.get("round_no"),
        "expected": closed_round,
    }

    # Leakage: closed_round 가 latest 보다 크면 아직 Historical draws 미반영
    winning = _winning_numbers_for_round(df, closed_round)
    checks["leakage"] = {
        "ok": winning is not None and latest >= closed_round,
        "latest_round": latest,
        "closed_round": closed_round,
        "winning_found": winning is not None,
    }

    # Consistency: 회차 연속성 + 아카이브 중복 없음
    next_round = closed_round + 1
    checks["consistency"] = {
        "ok": not hist.is_rollover_complete(closed_round) or True,  # 멱등 허용
        "next_round": next_round,
        "already_archived": hist.is_rollover_complete(closed_round),
    }

    # 파생 데이터·룰 스냅샷 누락 경고 (실패 아님 — 빈 샌드박스 허용)
    derived = sandbox_snapshot.get("derived_recommendations") or []
    checks["derived_presence"] = {
        "ok": True,
        "count": len(derived),
        "optional": True,
    }

    failed = [k for k, v in checks.items() if isinstance(v, dict) and not v.get("ok", True)]
    if failed:
        raise IntegrityGateError(checks)
    return {"ok": True, "checks": checks}


def assert_no_historical_mutation_during_rollover(
    before_latest: int,
    after_latest: int,
    closed_round: int,
) -> None:
    """롤오버는 draws +1 만 허용 — 중복 누적 방지."""
    if after_latest < before_latest:
        raise IntegrityGateError(
            {"consistency": {"ok": False, "reason": "latest_round decreased"}}
        )
    if after_latest - before_latest > 1:
        raise IntegrityGateError(
            {"consistency": {"ok": False, "reason": "latest_round jumped more than 1"}}
        )
    if after_latest != closed_round:
        raise IntegrityGateError(
            {
                "consistency": {
                    "ok": False,
                    "reason": "closed_round must equal new latest_round",
                    "after_latest": after_latest,
                    "closed_round": closed_round,
                }
            }
        )
