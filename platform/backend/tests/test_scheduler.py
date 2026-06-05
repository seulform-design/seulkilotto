"""스케줄러 작업 단위 테스트."""
from unittest.mock import patch

from app.scheduler import start_scheduler, stop_scheduler


def test_scheduler_disabled_by_default():
    stop_scheduler()
    start_scheduler()
    # SCHEDULER_ENABLED=False 이면 크래시 없이 통과
    stop_scheduler()
