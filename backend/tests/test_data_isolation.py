"""데이터셋 격리 아키텍처 테스트."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from app.datasets.current import CURRENT_DIR, CurrentDrawSandbox
from app.datasets.historical import HISTORICAL_DIR, HistoricalDataset
from app.datasets.immutable import assert_not_mutating_source, freeze_dataframe
from app.datasets.types import DerivedRecommendation, RuleSnapshot
from app.pipeline.integrity import evaluate_recommendation_backtest, run_integrity_gate
from app.pipeline.rule_engine import CurrentDrawRuleEngine
from app.pipeline.rollover import execute_saturday_rollover


@pytest.fixture
def isolated_data_dirs(tmp_path, monkeypatch):
    hist_dir = tmp_path / "historical"
    cur_dir = tmp_path / "current"
    hist_dir.mkdir()
    cur_dir.mkdir()
    monkeypatch.setattr("app.datasets.historical.HISTORICAL_DIR", hist_dir)
    monkeypatch.setattr("app.datasets.historical.ARCHIVE_PATH", hist_dir / "round_archives.json")
    monkeypatch.setattr("app.datasets.historical.ROLLOVER_LOG_PATH", hist_dir / "rollover_log.json")
    monkeypatch.setattr("app.datasets.current.CURRENT_DIR", cur_dir)
    monkeypatch.setattr("app.datasets.current.STATE_PATH", cur_dir / "sandbox_state.json")
    monkeypatch.setattr("app.datasets.current.PHOTO_PATH", cur_dir / "photo_entries.json")
    monkeypatch.setattr("app.datasets.current.DERIVED_PATH", cur_dir / "derived_recommendations.json")
    return tmp_path


def test_freeze_dataframe_deep_copy():
    df = pd.DataFrame({"round": [1, 2], "num1": [1, 2]})
    snap = freeze_dataframe(df)
    snap.loc[0, "num1"] = 99
    assert df.loc[0, "num1"] == 1


def test_rule_engine_does_not_mutate_historical(monkeypatch, isolated_data_dirs):
    hist = HistoricalDataset()

    class FakeHist(HistoricalDataset):
        def get_completed_rounds_only(self):
            return pd.DataFrame(
                {
                    "round": [1, 2],
                    "num1": [1, 3],
                    "num2": [2, 4],
                    "num3": [3, 5],
                    "num4": [4, 6],
                    "num5": [5, 7],
                    "num6": [6, 8],
                    "bonus": [7, 9],
                    "draw_date": ["2020-01-01", "2020-01-08"],
                }
            )

    fake = FakeHist()
    source = fake.get_completed_rounds_only()
    before = freeze_dataframe(source)

    engine = CurrentDrawRuleEngine(round_no=3, engine="weighted", params={"lookback": 2})
    monkeypatch.setattr(
        "app.analytics.generate_weighted_sets",
        lambda df, **kw: type("R", (), {"model_dump": lambda self: {"sets": []}})(),
    )
    engine.produce_weighted_sets(historical=fake, n_sets=1, lookback=2)
    assert_not_mutating_source(before, source)


def test_current_sandbox_write_and_freeze(isolated_data_dirs, monkeypatch):
    monkeypatch.setattr(CurrentDrawSandbox, "_meta_current_round", lambda self: 1227)
    sb = CurrentDrawSandbox()
    sb._init_sandbox(1227)
    derived = DerivedRecommendation(
        round_no=1227,
        engine="weighted",
        payload={"sets": [{"numbers": [1, 2, 3, 4, 5, 6]}]},
        rule_snapshot=RuleSnapshot(round_no=1227, engine="weighted", params={}),
    )
    sb.append_derived_recommendation(derived)
    assert len(sb.list_derived_recommendations()) == 1
    sb.freeze()
    with pytest.raises(Exception):
        sb.append_derived_recommendation(derived)


def test_rollover_idempotent(isolated_data_dirs, monkeypatch):
    monkeypatch.setattr(CurrentDrawSandbox, "_meta_current_round", lambda self: 10)
    sb = CurrentDrawSandbox()
    sb._init_sandbox(10)
    sb.append_photo_entry({"id": "p1", "video_intent": "current_round"})

    hist = HistoricalDataset()

    df = pd.DataFrame(
        {
            "round": [10],
            "num1": [1],
            "num2": [2],
            "num3": [3],
            "num4": [4],
            "num5": [5],
            "num6": [6],
            "bonus": [7],
            "draw_date": ["2020-01-01"],
        }
    )
    monkeypatch.setattr("app.pipeline.rollover.load_history", lambda: df)
    monkeypatch.setattr("app.pipeline.integrity.load_history", lambda: df)
    monkeypatch.setattr(
        "app.pipeline.rollover.get_history_meta",
        lambda: {"latest_round": 10, "current_round": 11},
    )
    monkeypatch.setattr(
        "app.pipeline.integrity.get_history_meta",
        lambda: {"latest_round": 10, "current_round": 11},
    )
    monkeypatch.setattr("app.pipeline.rollover.effective_current_round", lambda x: x + 1)

    r1 = execute_saturday_rollover(10, sandbox=sb, historical=hist, before_latest=9)
    assert r1.ok
    assert hist.is_rollover_complete(10)
    assert sb.get_state().round_no == 11

    r2 = execute_saturday_rollover(10, sandbox=sb, historical=hist, before_latest=9)
    assert r2.ok and r2.idempotent


def test_backtest_evaluation():
    winning = {1, 2, 3, 10, 20, 30}
    runs = [
        {
            "engine": "weighted",
            "payload": {"sets": [{"numbers": [1, 2, 3, 4, 5, 6]}, {"numbers": [10, 20, 30, 40, 41, 42]}]},
        }
    ]
    out = evaluate_recommendation_backtest(10, runs, winning)
    assert out["best_hit"] == 3
