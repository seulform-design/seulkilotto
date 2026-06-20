"""Current Draw 규칙 기반 데이터 생산 파이프라인.

[Historical (Immutable)] -> [Rule Engine] -> [Derived Generation] -> [Current Sandbox]
"""
from __future__ import annotations

from typing import Any, Dict, Optional

import pandas as pd

from .. import analytics
from ..config import settings
from ..schemas import GenerateResponse
from ..datasets.current import CurrentDrawSandbox, get_current_sandbox
from ..datasets.historical import HistoricalDataset, get_historical_dataset
from ..datasets.immutable import assert_not_mutating_source, freeze_dataframe
from ..datasets.types import DerivedRecommendation, RuleSnapshot


class CurrentDrawRuleEngine:
    """이번 회차 전용 규칙·가중치 주입 엔진."""

    def __init__(
        self,
        *,
        round_no: int,
        engine: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.round_no = int(round_no)
        self.engine = engine
        self.params = dict(params or {})

    def snapshot(self) -> RuleSnapshot:
        return RuleSnapshot(round_no=self.round_no, engine=self.engine, params=self.params)

    def _load_historical_input(self, historical: HistoricalDataset) -> pd.DataFrame:
        """과거 확정 회차만 — Current 회차 데이터 미포함."""
        return historical.get_completed_rounds_only()

    def produce_weighted_sets(
        self,
        *,
        n_sets: int = 1,
        lookback: int | None = None,
        exclude_consecutive: bool = False,
        seed: int | None = None,
        historical: HistoricalDataset | None = None,
    ) -> GenerateResponse:
        hist = historical or get_historical_dataset()
        source_df = self._load_historical_input(hist)
        before = freeze_dataframe(source_df)

        lb = int(lookback if lookback is not None else settings.UNSEEN_LOOKBACK_DRAWS)
        result = analytics.generate_weighted_sets(
            source_df,
            n_sets=n_sets,
            unseen_bonus=float(self.params.get("unseen_bonus", settings.UNSEEN_WEIGHT_BONUS)),
            lookback=lb,
            exclude_consecutive=exclude_consecutive,
            seed=seed,
        )
        assert_not_mutating_source(before, source_df, label="historical_draws")
        return result

    def produce_smart_sets(
        self,
        *,
        n_sets: int = 5,
        lookback: int = 5,
        exclude_consecutive: bool = True,
        max_overlap: int = 2,
        seed: int | None = None,
        historical: HistoricalDataset | None = None,
    ) -> GenerateResponse:
        hist = historical or get_historical_dataset()
        source_df = self._load_historical_input(hist)
        before = freeze_dataframe(source_df)

        result = analytics.generate_smart_sets(
            source_df,
            n_sets=n_sets,
            lookback=lookback,
            exclude_consecutive=exclude_consecutive,
            max_overlap=max_overlap,
            seed=seed,
        )
        assert_not_mutating_source(before, source_df, label="historical_draws")
        return result

    def produce_and_persist_weighted(
        self,
        sandbox: CurrentDrawSandbox | None = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        sb = sandbox or get_current_sandbox()
        result = self.produce_weighted_sets(**kwargs)
        derived = DerivedRecommendation(
            round_no=self.round_no,
            engine=self.engine,
            payload=result.model_dump() if hasattr(result, "model_dump") else dict(result),
            rule_snapshot=self.snapshot(),
        )
        sb.append_derived_recommendation(derived)
        return {
            "round_no": self.round_no,
            "engine": self.engine,
            "scope": "current_sandbox",
            "rule_snapshot": derived.rule_snapshot.to_dict(),
            "result": derived.payload,
        }

    def produce_and_persist_smart(
        self,
        sandbox: CurrentDrawSandbox | None = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        sb = sandbox or get_current_sandbox()
        result = self.produce_smart_sets(**kwargs)
        derived = DerivedRecommendation(
            round_no=self.round_no,
            engine=self.engine,
            payload=result.model_dump() if hasattr(result, "model_dump") else dict(result),
            rule_snapshot=self.snapshot(),
        )
        sb.append_derived_recommendation(derived)
        return {
            "round_no": self.round_no,
            "engine": self.engine,
            "scope": "current_sandbox",
            "rule_snapshot": derived.rule_snapshot.to_dict(),
            "result": derived.payload,
        }


def build_rule_engine_for_current(
    engine: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    round_no: int | None = None,
) -> CurrentDrawRuleEngine:
    from ..data_meta import get_history_meta, effective_current_round

    meta = get_history_meta()
    latest = int(meta.get("latest_round") or 0)
    rnd = round_no if round_no is not None else effective_current_round(latest)
    return CurrentDrawRuleEngine(round_no=rnd, engine=engine, params=params)
