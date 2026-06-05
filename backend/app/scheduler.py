"""주간 자동 회차 업그레이드 스케줄러."""
from __future__ import annotations

import logging

from .config import settings

logger = logging.getLogger(__name__)
_scheduler = None


def start_scheduler() -> None:
    global _scheduler
    if not settings.SCHEDULER_ENABLED:
        return
    if _scheduler is not None:
        return

    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
    except ImportError:
        logger.warning("APScheduler 미설치 — 자동 업그레이드 비활성")
        return

    from .round_upgrade import upgrade_rounds

    def _job():
        try:
            result = upgrade_rounds()
            logger.info("자동 회차 업그레이드: %s", result)
        except Exception as exc:  # noqa: BLE001
            logger.exception("자동 업그레이드 실패: %s", exc)

    _scheduler = BackgroundScheduler()
    # 매주 토요일 22:30 (추첨 후)
    _scheduler.add_job(_job, CronTrigger(day_of_week="sat", hour=22, minute=30))
    _scheduler.start()
    logger.info("회차 자동 업그레이드 스케줄러 시작 (토 22:30)")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
