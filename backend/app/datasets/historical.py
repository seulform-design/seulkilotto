"""Historical Dataset — IMMUTABLE & READ-ONLY.

1회차~N-1회차 확정 데이터만 조회. 실시간 CUD 금지.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from ..data_meta import get_history_meta
from ..database import load_history
from .immutable import freeze_dataframe, freeze_mapping, freeze_sequence
from .types import ArchivedRoundBundle

_DATA_ROOT = Path(__file__).resolve().parents[2] / "data" / "datasets"
HISTORICAL_DIR = _DATA_ROOT / "historical"
ARCHIVE_PATH = HISTORICAL_DIR / "round_archives.json"
ROLLOVER_LOG_PATH = HISTORICAL_DIR / "rollover_log.json"


class HistoricalWriteForbiddenError(RuntimeError):
    """Historical Dataset 에 대한 런타임 쓰기 시도."""


class HistoricalDataset:
    """과거 누적 데이터 읽기 전용 게이트웨이."""

    def __init__(self) -> None:
        HISTORICAL_DIR.mkdir(parents=True, exist_ok=True)

    def get_draws_snapshot(self, *, max_round: int | None = None) -> pd.DataFrame:
        """당첨 이력 스냅숏 (깊은 복사, 불변)."""
        df = freeze_dataframe(load_history())
        if max_round is not None and not df.empty:
            df = df[df["round"].astype(int) <= int(max_round)].copy(deep=True)
        return df

    def get_completed_rounds_only(self) -> pd.DataFrame:
        """N-1 이하(확정 추첨)만 — Current 회차 제외."""
        meta = get_history_meta()
        latest = int(meta.get("latest_round") or 0)
        return self.get_draws_snapshot(max_round=latest)

    def load_archived_round(self, round_no: int) -> Optional[ArchivedRoundBundle]:
        archives = self._load_archives()
        hit = archives.get(str(round_no))
        if not hit:
            return None
        return ArchivedRoundBundle(
            round_no=int(round_no),
            photo_entries=freeze_sequence(hit.get("photo_entries") or []),
            derived_recommendations=freeze_sequence(hit.get("derived_recommendations") or []),
            rule_snapshots=freeze_sequence(hit.get("rule_snapshots") or []),
            backtest=freeze_mapping(hit.get("backtest") or {}),
            archived_at=str(hit.get("archived_at") or ""),
        )

    def list_archived_rounds(self) -> List[int]:
        archives = self._load_archives()
        return sorted(int(k) for k in archives.keys())

    def is_rollover_complete(self, round_no: int) -> bool:
        log = self._load_rollover_log()
        entry = log.get(str(round_no)) or {}
        return entry.get("status") == "completed"

    def _load_archives(self) -> Dict[str, Any]:
        if not ARCHIVE_PATH.exists():
            return {}
        try:
            data = json.loads(ARCHIVE_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _load_rollover_log(self) -> Dict[str, Any]:
        if not ROLLOVER_LOG_PATH.exists():
            return {}
        try:
            data = json.loads(ROLLOVER_LOG_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _merge_archive_bundle(self, bundle: ArchivedRoundBundle) -> None:
        """롤오버 배치 전용 — 유일한 Historical 대량 쓰기 윈도우."""
        archives = self._load_archives()
        key = str(bundle.round_no)
        if key in archives:
            return  # 멱등: 이미 병합됨
        archives[key] = bundle.to_dict()
        ARCHIVE_PATH.write_text(json.dumps(archives, ensure_ascii=False, indent=2), encoding="utf-8")

    def _mark_rollover_complete(self, round_no: int, *, backtest_summary: Dict[str, Any]) -> None:
        log = self._load_rollover_log()
        log[str(round_no)] = {
            "status": "completed",
            "completed_at": backtest_summary.get("evaluated_at"),
            "backtest_hits": backtest_summary.get("best_hit"),
        }
        ROLLOVER_LOG_PATH.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")


_historical_singleton: HistoricalDataset | None = None


def get_historical_dataset() -> HistoricalDataset:
    global _historical_singleton
    if _historical_singleton is None:
        _historical_singleton = HistoricalDataset()
    return _historical_singleton
