"""snapshot_store persist/list/load 단위 테스트 (임시 디렉터리)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.epo import snapshot_store as store  # noqa: E402
from app.epo.historical_stats import _FALLBACK  # noqa: E402
from app.epo.statistics_snapshot import profile_to_snapshot  # noqa: E402


@pytest.fixture()
def snap_dir(tmp_path, monkeypatch):
    d = tmp_path / "statistics_snapshots"
    d.mkdir()
    monkeypatch.setattr(store, "SNAPSHOT_DIR", d)
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return d


def test_persist_list_load_no_overwrite(snap_dir):
    snap = profile_to_snapshot(_FALLBACK, created_at="2026-07-30T00:00:00+00:00")
    meta1 = store.persist_snapshot(snap, tag="t")
    assert meta1["ok"] is True
    assert (snap_dir / meta1["filename"]).is_file()

    meta2 = store.persist_snapshot(snap, tag="t")
    assert meta1["filename"] != meta2["filename"]  # 누적, 덮어쓰기 없음

    listed = store.list_snapshots(limit=10)
    assert listed["ok"] and listed["total_files"] >= 2
    assert listed["items"][0]["filename"]

    loaded = store.load_snapshot(meta1["filename"])
    assert loaded is not None
    assert loaded["version"] == snap["version"]
    assert loaded["honesty"]

    # path traversal blocked
    assert store.load_snapshot("../secret.json") is None
    assert store.load_snapshot("not_a_snapshot.json") is None


def test_list_parse_rounds(snap_dir):
    snap = profile_to_snapshot(_FALLBACK)
    snap["source"]["rounds"]["count"] = 0
    meta = store.persist_snapshot(snap)
    listed = store.list_snapshots()
    item = next(i for i in listed["items"] if i["filename"] == meta["filename"])
    assert item.get("rounds_count") == 0
