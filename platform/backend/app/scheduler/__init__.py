"""APScheduler 설정."""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings
from app.scheduler.jobs import rebuild_all_patterns_job, sync_csv_incremental

logger = logging.getLogger(__name__)
_scheduler: BackgroundScheduler | None = None


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    if not settings.SCHEDULER_ENABLED:
        return

    _scheduler = BackgroundScheduler(timezone="Asia/Seoul")
    # 매일 22:30 CSV 동기화 (추첨일)
    _scheduler.add_job(sync_csv_incremental, "cron", hour=22, minute=30, id="sync_csv")
    # 매주 일요일 03:00 패턴 통계 재구축
    _scheduler.add_job(rebuild_all_patterns_job, "cron", day_of_week="sun", hour=3, id="rebuild_patterns")
    _scheduler.start()
    logger.info("APScheduler started")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
