"""model_registry_store — human disable/enable, never auto-mutate."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.video_analysis import model_registry_store as reg  # noqa: E402


def test_disable_requires_confirm(tmp_path, monkeypatch):
    monkeypatch.setattr(reg, "DATA_DIR", tmp_path)
    monkeypatch.setattr(reg, "ARCHIVE_PATH", tmp_path / "model_registry_archive.json")
    bad = reg.apply_disable("feature:weak", reason="test", confirmed=False)
    assert bad["ok"] is False and bad["auto_applied"] is False
    assert reg.list_disabled_ids() == set()


def test_disable_enable_archive(tmp_path, monkeypatch):
    monkeypatch.setattr(reg, "DATA_DIR", tmp_path)
    monkeypatch.setattr(reg, "ARCHIVE_PATH", tmp_path / "model_registry_archive.json")
    ok = reg.apply_disable("feature:weak", reason="ops", confirmed=True, by="tester")
    assert ok["ok"] is True and ok["auto_applied"] is False
    assert "feature:weak" in reg.list_disabled_ids()
    state = reg.get_registry_state()
    assert state["auto_mutate_scoring"] is False
    assert state["event_count"] >= 1

    reports = [
        {"key": "weak", "adopted": True, "validation_passed": True, "exclude_reason": [], "use_reason": ["x"]},
        {"key": "support", "adopted": True, "validation_passed": True, "exclude_reason": [], "use_reason": ["y"]},
    ]
    out = reg.apply_human_disables_to_feature_reports(reports)
    assert out[0]["adopted"] is False and out[0]["human_disabled"] is True
    assert out[1]["adopted"] is True

    en = reg.apply_enable("feature:weak", confirmed=True, by="tester")
    assert en["ok"] is True
    assert "feature:weak" not in reg.list_disabled_ids()
    # events kept
    assert reg.get_registry_state()["event_count"] >= 2
