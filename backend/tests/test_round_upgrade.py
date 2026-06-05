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
