"""토요일 당첨 후 원자적 롤오버 배치.

STEP 1 Freeze -> STEP 2 Backtest -> STEP 3 Integrity -> STEP 4 Merge -> STEP 5 Init N+1
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Set

import pandas as pd

from ..data_meta import effective_current_round, get_history_meta
from ..database import load_history
from ..datasets.current import CurrentDrawSandbox, get_current_sandbox
from ..datasets.historical import HistoricalDataset, get_historical_dataset
from ..datasets.types import ArchivedRoundBundle, RolloverResult
from .integrity import (
    IntegrityGateError,
    assert_no_historical_mutation_during_rollover,
    evaluate_recommendation_backtest,
    run_integrity_gate,
)

logger = logging.getLogger(__name__)


def _winning_numbers(df: pd.DataFrame, round_no: int) -> Optional[Set[int]]:
    if df.empty:
        return None
    row = df[df["round"].astype(int) == int(round_no)]
    if row.empty:
        return None
    r = row.iloc[0]
    return {int(r[f"num{i}"]) for i in range(1, 7)}


def execute_saturday_rollover(
    closed_round: int | None = None,
    *,
    sandbox: CurrentDrawSandbox | None = None,
    historical: HistoricalDataset | None = None,
    before_latest: int | None = None,
) -> RolloverResult:
    """멱등·원자적 롤오버. closed_round 기본값 = CSV 최신 확정 회차."""
    hist = historical or get_historical_dataset()
    sb = sandbox or get_current_sandbox()
    meta = get_history_meta()
    latest = int(meta.get("latest_round") or 0)
    rnd = int(closed_round if closed_round is not None else latest)

    if rnd <= 0:
        return RolloverResult(ok=False, closed_round=0, next_round=0, error="invalid closed_round")

    # 멱등성: 이미 완료된 회차
    if hist.is_rollover_complete(rnd):
        next_r = effective_current_round(latest)
        return RolloverResult(
            ok=True,
            closed_round=rnd,
            next_round=next_r,
            idempotent=True,
        )

    df = load_history()
    winning = _winning_numbers(df, rnd)
    if not winning:
        return RolloverResult(
            ok=False,
            closed_round=rnd,
            next_round=rnd + 1,
            error=f"round {rnd} winning numbers not in historical draws yet",
        )

    frozen = False
    try:
        # STEP 1: 동결
        sb.freeze()
        frozen = True
        snapshot = sb.export_snapshot()

        # STEP 2: 백테스트
        backtest = evaluate_recommendation_backtest(
            rnd,
            snapshot.get("derived_recommendations") or [],
            winning,
        )

        # STEP 3: 무결성 게이트
        integrity = run_integrity_gate(rnd, snapshot, historical=hist)

        if before_latest is not None:
            assert_no_historical_mutation_during_rollover(before_latest, latest, rnd)

        # STEP 4: Historical 병합 (유일한 대량 쓰기 윈도우)
        bundle = ArchivedRoundBundle(
            round_no=rnd,
            photo_entries=list(snapshot.get("photo_entries") or []),
            derived_recommendations=list(snapshot.get("derived_recommendations") or []),
            rule_snapshots=[
                (r.get("rule_snapshot") or {})
                for r in (snapshot.get("derived_recommendations") or [])
            ],
            backtest=backtest,
        )
        hist._merge_archive_bundle(bundle)
        hist._mark_rollover_complete(rnd, backtest_summary=backtest)

        # STEP 5: 차기 샌드박스 초기화
        next_round = effective_current_round(latest)
        sb.flush_and_init_next(next_round)

        merged = (
            len(bundle.photo_entries)
            + len(bundle.derived_recommendations)
            + len(bundle.rule_snapshots)
        )
        logger.info(
            "Saturday rollover OK: round=%s next=%s merged_items=%s",
            rnd,
            next_round,
            merged,
        )
        return RolloverResult(
            ok=True,
            closed_round=rnd,
            next_round=next_round,
            backtest=backtest,
            integrity=integrity,
            merged_items=merged,
        )
    except IntegrityGateError as exc:
        logger.error("Rollover integrity failed round=%s: %s", rnd, exc.checks)
        if frozen:
            sb.unfreeze()
        return RolloverResult(
            ok=False,
            closed_round=rnd,
            next_round=rnd + 1,
            integrity=getattr(exc, "checks", None),
            error=str(exc),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Rollover aborted round=%s", rnd)
        if frozen:
            sb.unfreeze()
        return RolloverResult(
            ok=False,
            closed_round=rnd,
            next_round=rnd + 1,
            error=str(exc),
        )


def maybe_rollover_after_upgrade(
    upgrade_result: Dict[str, Any],
) -> Optional[RolloverResult]:
    """CSV 업그레이드 후 신규 확정 회차가 있으면 롤오버 시도."""
    before = int(upgrade_result.get("before_latest") or 0)
    after = int(upgrade_result.get("after_latest") or 0)
    synced = upgrade_result.get("synced_rounds") or []
    if after <= before or not synced:
        return None
    # 가장 최근 동기화 회차에 대해 롤오버 (멱등)
    closed = int(synced[-1])
    return execute_saturday_rollover(closed, before_latest=before)
