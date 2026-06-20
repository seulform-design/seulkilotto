"""회차 업그레이드 상태 테스트."""
from app.data_meta import effective_current_round


def test_effective_current_round():
    assert effective_current_round(1226) >= 1227


def test_get_upgrade_status_structure():
    from app.round_upgrade import get_upgrade_status

    status = get_upgrade_status()
    assert "latest_round" in status
    assert "pending_count" in status
    assert "can_upgrade" in status


def test_upgrade_rounds_rolls_over_only_matching_sandbox_round(monkeypatch):
    import pandas as pd
    from app.round_upgrade import upgrade_rounds

    monkeypatch.setattr(
        "app.round_upgrade.get_upgrade_status",
        lambda: {
            "latest_round": 10,
            "api_latest_round": 12,
            "can_upgrade": True,
        },
    )

    class CrawlMod:
        @staticmethod
        def crawl(**_kwargs):
            return (2, 0, 0)

    monkeypatch.setattr("app.round_upgrade._crawl_module", lambda: CrawlMod)
    monkeypatch.setattr("app.round_upgrade.invalidate_history_cache", lambda: None)
    monkeypatch.setattr("app.round_upgrade._sync_v2_database", lambda: {"ok": True})
    monkeypatch.setattr(
        "app.round_upgrade.get_history_meta",
        lambda: {"latest_round": 12, "current_round": 13},
    )
    monkeypatch.setattr(
        "app.round_upgrade.load_history",
        lambda: pd.DataFrame(
            [
                {"round": 11, "num1": 1, "num2": 2, "num3": 3, "num4": 4, "num5": 5, "num6": 6, "bonus": 7},
                {"round": 12, "num1": 8, "num2": 9, "num3": 10, "num4": 11, "num5": 12, "num6": 13, "bonus": 14},
            ]
        ),
    )
    monkeypatch.setattr(
        "app.round_upgrade.get_current_dataset_state",
        lambda: {"current_round": 11, "entries": [{"id": "x"}]},
    )
    monkeypatch.setattr("app.round_upgrade.CSV_DATA_PATH", __import__("pathlib").Path("/tmp/nonexistent.csv"))

    calls: list[tuple[int, int]] = []

    def fake_rollover_current_dataset(*, drawn_round, next_round, winning_numbers, bonus):
        calls.append((drawn_round, next_round))
        assert winning_numbers == [1, 2, 3, 4, 5, 6]
        assert bonus == 7
        return {"ok": True, "rolled_over": True}

    monkeypatch.setattr("app.round_upgrade.rollover_current_dataset", fake_rollover_current_dataset)

    result = upgrade_rounds()
    assert result["ok"] is True
    assert calls == [(11, 12)]
