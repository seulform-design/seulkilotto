"""주간 자동 회차 업그레이드 스케줄러."""
from __future__ import annotations

import logging

from .config import settings

logger = logging.getLogger(__name__)
_scheduler = None


def start_scheduler() -> None:
    global _scheduler
    if not settings.SCHEDULER_ENABLED:
        logger.info("SCHEDULER_ENABLED=False — 자동 업그레이드 비활성 (환경변수로 활성화 가능)")
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
            new_r = result.get("new_rounds", 0)
            after = result.get("after_latest", "?")
            if new_r > 0:
                logger.info("자동 회차 업그레이드 완료: %s회 신규 (최신=%s회)", new_r, after)
            else:
                logger.info("자동 회차 업그레이드: 신규 없음 (최신=%s회)", after)
        except Exception as exc:  # noqa: BLE001
            logger.exception("자동 업그레이드 실패: %s", exc)

    _scheduler = BackgroundScheduler()
    # 매주 토요일 22:35 KST (추첨 ~20:50, 결과 공개 ~21:xx 후 여유분)
    # Railway 서버는 UTC 기준 → KST 22:35 = UTC 13:35
    _scheduler.add_job(
        _job,
        CronTrigger(day_of_week="sat", hour=13, minute=35, timezone="UTC"),
        id="weekly_upgrade_sat",
        replace_existing=True,
    )
    # 혹시 토요일 실패 시 일요일 04:00 KST (UTC 일요일 19:00 토요일) 재시도
    _scheduler.add_job(
        _job,
        CronTrigger(day_of_week="sun", hour=19, minute=0, timezone="UTC"),
        id="weekly_upgrade_sun_retry",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("회차 자동 업그레이드 스케줄러 시작 (토 22:35 KST / 일 04:00 KST 재시도)")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
