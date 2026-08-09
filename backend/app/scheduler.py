"""주간 자동 회차 업그레이드 스케줄러."""
from __future__ import annotations

import logging

from .config import settings

logger = logging.getLogger(__name__)
_scheduler = None

# 부팅 후 캐치업 크롤까지의 지연(초) — 서버가 뜨고 헬스체크를 통과한 뒤 실행되도록.
# 배포 직후 CSV 리셋 → 복기/이번회차 라벨이 밀리는 구간을 줄이기 위해 빠르게 캐치업.
BOOT_CATCHUP_DELAY_SEC = 8


def warm_engine_caches(context: str = "warm") -> None:
    """무거운 엔진 캐시 프리워밍.

    무거운 학습 엔진들의 콜드 계산이 60s 게이트웨이를 넘겨 504 가 나면, 결과가
    캐시에 담기지도 못해 매 요청이 콜드로 반복된다(추천이 부하마다 흔들려 '확률이
    떨어져 보이는' 원인). 백그라운드(게이트웨이 제한 없음)에서 미리 계산해 15분
    캐시를 항상 따뜻하게 유지하면, HTTP 요청은 완전·안정된 캐시를 즉시 받는다."""
    import time

    t0 = time.time()
    try:
        from .video_analysis.feature_learning_engine import build_feature_learning
        from .video_analysis.pattern_mining_engine import build_pattern_mining
        from .video_analysis.round_learning import build_round_learning
        from .video_analysis.overlap_learning import build_overlap_learning
        from .video_analysis.graft_coverage import build_graft_coverage
        from .video_analysis.carryover_learning import build_carryover_learning
        from .video_analysis.review_verification import build_review_verification
    except Exception as exc:  # noqa: BLE001
        logger.warning("[%s] 프리워밍 import 실패: %s", context, exc)
        return

    calls = [
        ("review_verification", build_review_verification),
        ("carryover", build_carryover_learning),
        ("graft:review", lambda: build_graft_coverage(intent="review")),
        ("graft:current", lambda: build_graft_coverage(intent="current_round")),
    ]
    for intent in ("current_round", "review"):
        calls.append((f"feature:{intent}", lambda i=intent: build_feature_learning(apply_intent=i)))
        calls.append((f"pattern:{intent}", lambda i=intent: build_pattern_mining(apply_intent=i)))
        calls.append((f"round:{intent}", lambda i=intent: build_round_learning(apply_intent=i)))
        calls.append((f"overlap:{intent}", lambda i=intent: build_overlap_learning(apply_intent=i)))

    ok = 0
    for name, fn in calls:
        try:
            fn()
            ok += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("[%s] 프리워밍 실패 %s: %s", context, name, exc)
    logger.info("[%s] 엔진 캐시 프리워밍 %d/%d 완료 (%.1fs)", context, ok, len(calls), time.time() - t0)


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

    def _job(context: str = "scheduled"):
        try:
            result = upgrade_rounds()
            new_r = result.get("new_rounds", 0)
            after = result.get("after_latest", "?")
            if new_r > 0:
                logger.info("[%s] 회차 업그레이드 완료: %s회 신규 (최신=%s회)", context, new_r, after)
            else:
                logger.info("[%s] 회차 업그레이드: 신규 없음 (최신=%s회)", context, after)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[%s] 자동 업그레이드 실패: %s", context, exc)

    _scheduler = BackgroundScheduler()

    # ── 부팅 캐치업(핵심 자기치유) ─────────────────────────────────────────
    # 주간 크론만으로는 회차가 뒤처진다:
    #  (1) Railway 무료티어는 크론 시각에 컨테이너가 슬립이면 크론을 놓친다.
    #  (2) 재배포(코드 푸시)는 이미지 베이스라인 CSV(과거)로 런타임 CSV 를 리셋해,
    #      직전에 크롤한 최신 회차가 사라진다(1232→1231 되돌아가는 실증 확인).
    # → 컨테이너가 뜰 때마다 1회 캐치업을 돌려 항상 최신 추첨 회차로 자기치유한다.
    #   서버 부팅/헬스체크를 막지 않도록 지연 후 백그라운드 스레드에서 실행.
    from datetime import datetime, timedelta, timezone

    _scheduler.add_job(
        _job,
        "date",
        run_date=datetime.now(timezone.utc) + timedelta(seconds=BOOT_CATCHUP_DELAY_SEC),
        args=["boot-catchup"],
        id="boot_catchup",
        replace_existing=True,
        misfire_grace_time=300,
    )
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
    # ── 엔진 캐시 프리워밍 (부팅 후 1회 + 10분 주기, 15분 TTL 아래로 유지) ──
    from apscheduler.triggers.interval import IntervalTrigger

    _scheduler.add_job(
        warm_engine_caches,
        "date",
        run_date=datetime.now(timezone.utc) + timedelta(seconds=BOOT_CATCHUP_DELAY_SEC + 25),
        args=["boot-warm"],
        id="engine_warm_boot",
        replace_existing=True,
        misfire_grace_time=600,
    )
    _scheduler.add_job(
        warm_engine_caches,
        IntervalTrigger(minutes=10),
        args=["interval-warm"],
        id="engine_warm_interval",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=600,
    )
    _scheduler.start()
    logger.info("회차 자동 업그레이드 + 엔진 캐시 프리워밍 스케줄러 시작 (프리워밍 부팅+10분 주기)")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
