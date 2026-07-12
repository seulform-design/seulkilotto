"""부팅 캐치업 회귀 — 컨테이너 시작 시 최신 회차로 자기치유.

재배포는 이미지 베이스라인 CSV(과거)로 런타임 CSV 를 리셋하고, 무료티어는 주간
크론 시각에 슬립이면 크론을 놓친다. 부팅 캐치업이 실질적 방어선이므로 스케줄러
시작 시 boot_catchup 잡이 항상 등록돼야 한다.
"""
import app.scheduler as sch
from app.config import settings


def test_start_scheduler_registers_boot_catchup(monkeypatch):
    import app.round_upgrade as ru

    calls = {"n": 0}

    def _stub(force: bool = False):
        calls["n"] += 1
        return {"new_rounds": 0, "after_latest": 1232}

    monkeypatch.setattr(ru, "upgrade_rounds", _stub)
    monkeypatch.setattr(settings, "SCHEDULER_ENABLED", True)

    # 이전 테스트 잔여 스케줄러 정리.
    sch.stop_scheduler()
    try:
        sch.start_scheduler()
        assert sch._scheduler is not None
        job_ids = {j.id for j in sch._scheduler.get_jobs()}
        assert "boot_catchup" in job_ids, "부팅 캐치업 잡 미등록"
        assert "weekly_upgrade_sat" in job_ids
        # 부팅 잡은 지연 실행(20s) 이라 테스트 중엔 아직 안 돎.
        assert calls["n"] == 0
    finally:
        sch.stop_scheduler()


def test_scheduler_disabled_registers_nothing(monkeypatch):
    monkeypatch.setattr(settings, "SCHEDULER_ENABLED", False)
    sch.stop_scheduler()
    sch.start_scheduler()
    assert sch._scheduler is None
