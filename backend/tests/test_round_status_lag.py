"""회차 CSV 지연 시 round_status 가 캐치업 힌트를 노출하는지."""
from __future__ import annotations

from app.video_analysis.draw_template import round_status


def test_round_status_has_sync_fields():
    st = round_status()
    assert "latest_round" in st
    assert "current_round" in st
    assert "review_round" in st
    assert "pending_count" in st
    assert "csv_lagging" in st
    assert "syncing" in st
    assert st["latest_round"] >= 1
    assert st["current_round"] == st["latest_round"] + 1 or st.get("csv_lagging")


def test_history_meta_always_exposes_latest_round():
    from app.data_meta import get_history_meta

    m = get_history_meta()
    assert "latest_round" in m
    assert "current_round" in m
    assert "next_round" in m
