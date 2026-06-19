"""회차별 데이터 업그레이드 — 동행복권 크롤 → CSV 갱신 → 캐시 무효화."""
from __future__ import annotations

import contextlib
import io
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import settings
from .data_meta import effective_current_round, get_history_meta
from .database import CSV_DATA_PATH, invalidate_history_cache, load_history
from .video_analysis.store import rollover_current_dataset

_CRAWL_MOD = None
_API_LATEST_CACHE: tuple[float, int] | None = None
_API_LATEST_TTL = 600  # 10분


def _crawl_module():
    global _CRAWL_MOD
    if _CRAWL_MOD is not None:
        return _CRAWL_MOD
    scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import crawl_lotto_history as mod  # type: ignore[import-untyped]

    _CRAWL_MOD = mod
    return mod


def _api_latest_round() -> int:
    global _API_LATEST_CACHE
    now = time.time()
    if _API_LATEST_CACHE and now - _API_LATEST_CACHE[0] < _API_LATEST_TTL:
        return _API_LATEST_CACHE[1]

    mod = _crawl_module()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        latest = mod.find_latest_round(
            timeout=15.0,
            delay=0.2,
            source=settings.CRAWL_SOURCE,  # type: ignore[arg-type]
        )
    _API_LATEST_CACHE = (now, latest)
    return latest


def get_upgrade_status() -> Dict[str, Any]:
    """로컬 CSV vs 공개 API 최신 회차 비교."""
    meta = get_history_meta()
    latest_csv = int(meta.get("latest_round") or 0)
    pending: List[int] = []

    try:
        api_latest = _api_latest_round()
        if api_latest > latest_csv:
            pending = list(range(latest_csv + 1, api_latest + 1))
    except Exception as exc:  # noqa: BLE001
        return {
            **meta,
            "api_latest_round": None,
            "pending_rounds": [],
            "pending_count": 0,
            "can_upgrade": False,
            "api_error": str(exc),
        }

    return {
        **meta,
        "api_latest_round": api_latest,
        "pending_rounds": pending,
        "pending_count": len(pending),
        "can_upgrade": len(pending) > 0,
        "next_round": effective_current_round(latest_csv),
    }


def upgrade_rounds(force: bool = False) -> Dict[str, Any]:
    """누락 회차를 크롤링해 CSV에 반영한다."""
    before = get_upgrade_status()
    latest_csv = int(before.get("latest_round") or 0)
    api_latest = before.get("api_latest_round")
    previous_csv = CSV_DATA_PATH.read_bytes() if CSV_DATA_PATH.exists() else b""

    if not before.get("can_upgrade") and not force:
        return {
            "ok": True,
            "message": "업그레이드할 신규 회차가 없습니다.",
            "before_latest": latest_csv,
            "after_latest": latest_csv,
            "new_rounds": 0,
            "updated_rounds": 0,
            "failed_rounds": 0,
            "synced_rounds": [],
        }

    if api_latest is None:
        try:
            api_latest = _api_latest_round()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"최신 회차 조회 실패: {exc}"}

    start = latest_csv + 1 if not force else 1
    mod = _crawl_module()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        new_c, upd_c, fail_c = mod.crawl(
            start_round=start,
            end_round=int(api_latest),
            output_path=CSV_DATA_PATH,
            delay=settings.CRAWL_DELAY_SEC,
            timeout=15.0,
            source=settings.CRAWL_SOURCE,  # type: ignore[arg-type]
            force=force,
        )

    global _API_LATEST_CACHE
    invalidate_history_cache()
    _API_LATEST_CACHE = None

    after_meta = get_history_meta()
    after_latest = int(after_meta.get("latest_round") or 0)
    synced = list(range(latest_csv + 1, after_latest + 1)) if after_latest > latest_csv else []

    rollover = None
    try:
        if synced:
            df_after = load_history()
            for drawn_round in synced:
                row = df_after[df_after["round"].astype(int) == int(drawn_round)]
                if row.empty:
                    continue
                row0 = row.sort_values("round").iloc[-1]
                winning_numbers = [int(row0[f"num{i}"]) for i in range(1, 7)]
                bonus = int(row0["bonus"])
                rollover = rollover_current_dataset(
                    drawn_round=int(drawn_round),
                    next_round=int(after_meta.get("current_round") or after_latest + 1),
                    winning_numbers=winning_numbers,
                    bonus=bonus,
                )
                if rollover and not rollover.get("ok", True):
                    raise RuntimeError(rollover.get("error") or "current dataset rollover failed")
    except Exception as exc:  # noqa: BLE001
        if previous_csv:
            CSV_DATA_PATH.write_bytes(previous_csv)
        invalidate_history_cache()
        _API_LATEST_CACHE = None
        rollback_meta = get_history_meta()
        return {
            "ok": False,
            "error": f"현재회차 샌드박스 롤오버 실패: {exc}",
            "before_latest": latest_csv,
            "after_latest": int(rollback_meta.get('latest_round') or latest_csv),
            "current_round": rollback_meta.get("current_round"),
            "rolled_back": True,
        }

    v2_sync = _sync_v2_database()

    return {
        "ok": fail_c == 0 or new_c > 0,
        "before_latest": latest_csv,
        "after_latest": after_latest,
        "api_latest_round": api_latest,
        "new_rounds": new_c,
        "updated_rounds": upd_c,
        "failed_rounds": fail_c,
        "synced_rounds": synced,
        "current_round": after_meta.get("current_round"),
        "rollover": rollover,
        "v2_sync": v2_sync,
        "log_tail": buf.getvalue()[-2000:] if buf.getvalue() else "",
    }


def _sync_v2_database() -> Optional[Dict[str, Any]]:
    """platform v2 DB에 신규 회차 반영 (있을 때만)."""
    platform_root = Path(__file__).resolve().parent.parent.parent / "platform" / "backend"
    if not platform_root.is_dir():
        return None
    try:
        if str(platform_root) not in sys.path:
            sys.path.insert(0, str(platform_root))
        from app.scheduler.jobs import sync_csv_incremental  # type: ignore[import-untyped]

        return sync_csv_incremental()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
