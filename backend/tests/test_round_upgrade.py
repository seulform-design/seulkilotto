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


def _patch_upgrade_common(monkeypatch, *, latest_round, api_latest, crawl_ret, meta, sandbox):
    """upgrade_rounds 의 크롤/메타/샌드박스 의존성을 공통 스텁으로 대체."""
    monkeypatch.setattr(
        "app.round_upgrade.get_upgrade_status",
        lambda: {"latest_round": latest_round, "api_latest_round": api_latest, "can_upgrade": True},
    )

    class CrawlMod:
        @staticmethod
        def crawl(**_kwargs):
            return crawl_ret

    monkeypatch.setattr("app.round_upgrade._crawl_module", lambda: CrawlMod)
    monkeypatch.setattr("app.round_upgrade.invalidate_history_cache", lambda: None)
    monkeypatch.setattr("app.round_upgrade._sync_v2_database", lambda: {"ok": True})
    monkeypatch.setattr("app.round_upgrade.get_history_meta", lambda: meta)
    monkeypatch.setattr("app.round_upgrade.get_current_dataset_state", lambda: sandbox)
    monkeypatch.setattr(
        "app.round_upgrade.CSV_DATA_PATH", __import__("pathlib").Path("/tmp/nonexistent.csv")
    )


def test_upgrade_rounds_self_heals_stale_sandbox(monkeypatch):
    """샌드박스가 이미 추첨된 회차에 뒤처져 있으면(원인 무관) 최신 이번회차까지 자동 전진.

    예전엔 '이번 호출에서 막 동기화된 회차'에만 롤오버해서, 크론이 먼저 회차를
    올린 뒤엔 이번회차 데이터가 복기로 넘어가지 못하고 영구히 뒤처졌다.
    """
    from app.round_upgrade import upgrade_rounds

    _patch_upgrade_common(
        monkeypatch,
        latest_round=10,
        api_latest=12,
        crawl_ret=(2, 0, 0),
        meta={"latest_round": 12, "current_round": 13},
        sandbox={"current_round": 11, "entries": [{"id": "x"}]},
    )

    aligned: list[int] = []

    def fake_align(target_round):
        aligned.append(target_round)
        return {
            "ok": True,
            "before_round": 11,
            "after_round": target_round,
            "advanced": target_round - 11,
        }

    monkeypatch.setattr("app.round_upgrade.align_current_sandbox_to_round", fake_align)

    result = upgrade_rounds()
    assert result["ok"] is True
    # after_latest(12) + 1 = 13 까지 전진해야 한다.
    assert aligned == [13]
    assert result["photo_rollover"]["after_round"] == 13


def test_upgrade_rounds_skips_align_when_sandbox_already_current(monkeypatch):
    """샌드박스가 이미 최신 이번회차면 정렬을 호출하지 않는다(멱등)."""
    from app.round_upgrade import upgrade_rounds

    _patch_upgrade_common(
        monkeypatch,
        latest_round=12,
        api_latest=12,
        crawl_ret=(0, 0, 0),
        meta={"latest_round": 12, "current_round": 13},
        sandbox={"current_round": 13, "entries": []},
    )

    aligned: list[int] = []
    monkeypatch.setattr(
        "app.round_upgrade.align_current_sandbox_to_round",
        lambda target_round: (aligned.append(target_round), {"ok": True})[1],
    )

    result = upgrade_rounds()
    assert result["ok"] is True
    assert aligned == []  # 13 >= 13 → 스킵
    assert result["photo_rollover"] is None
