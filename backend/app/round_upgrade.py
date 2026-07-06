"""회차별 데이터 업그레이드 — 동행복권 크롤 → CSV 갱신 → 캐시 무효화."""
from __future__ import annotations

import contextlib
import io
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import settings
from .data_meta import effective_current_round, get_history_meta
from .database import CSV_DATA_PATH, invalidate_history_cache, load_history
from .video_analysis.store import get_current_dataset_state, rollover_current_dataset

_CRAWL_MOD = None
_API_LATEST_CACHE: tuple[float, int] | None = None
_API_LATEST_TTL = 600  # 10분
# 업그레이드(크롤→CSV 덮어쓰기)는 스케줄러 스레드와 수동 엔드포인트가 동시에
# 호출할 수 있다. 동시 크롤이 같은 CSV 를 덮어쓰면 손상되므로 한 번에 하나만
# 실행하도록 직렬화한다(이미 진행 중이면 즉시 반환).
_UPGRADE_LOCK = threading.Lock()


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
    """누락 회차를 크롤링해 CSV에 반영한다 (동시 실행 직렬화)."""
    if not _UPGRADE_LOCK.acquire(blocking=False):
        return {
            "ok": False,
            "in_progress": True,
            "message": "이미 회차 업그레이드가 진행 중입니다. 잠시 후 다시 시도하세요.",
        }
    try:
        return _upgrade_rounds_locked(force)
    finally:
        _UPGRADE_LOCK.release()


def _upgrade_rounds_locked(force: bool = False) -> Dict[str, Any]:
    before = get_upgrade_status()
    latest_csv = int(before.get("latest_round") or 0)
    api_latest = before.get("api_latest_round")
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

    photo_rollover = None
    try:
        if synced:
            current_state = get_current_dataset_state()
            sandbox_round = int(current_state.get("current_round") or 0)
            if sandbox_round in synced:
                df_after = load_history()
                row = df_after[df_after["round"].astype(int) == sandbox_round]
                if not row.empty:
                    row0 = row.sort_values("round").iloc[-1]
                    winning_numbers = [int(row0[f"num{i}"]) for i in range(1, 7)]
                    bonus = int(row0["bonus"])
                    photo_rollover = rollover_current_dataset(
                        drawn_round=sandbox_round,
                        next_round=sandbox_round + 1,
                        winning_numbers=winning_numbers,
                        bonus=bonus,
                    )
    except Exception as exc:  # noqa: BLE001
        photo_rollover = {"ok": False, "error": str(exc)}

    v2_sync = _sync_v2_database()

    result = {
        "ok": fail_c == 0 or new_c > 0,
        "before_latest": latest_csv,
        "after_latest": after_latest,
        "api_latest_round": api_latest,
        "new_rounds": new_c,
        "updated_rounds": upd_c,
        "failed_rounds": fail_c,
        "synced_rounds": synced,
        "current_round": after_meta.get("current_round"),
        "photo_rollover": photo_rollover,
        "v2_sync": v2_sync,
        "log_tail": buf.getvalue()[-2000:] if buf.getvalue() else "",
    }

    try:
        from .pipeline.rollover import maybe_rollover_after_upgrade

        rollover = maybe_rollover_after_upgrade(result)
        if rollover is not None:
            result["pipeline_rollover"] = rollover.to_dict()
    except Exception as exc:  # noqa: BLE001
        result["pipeline_rollover"] = {"ok": False, "error": str(exc)}

    return result


def _sync_v2_database() -> Optional[Dict[str, Any]]:
    """platform v2 DB에 신규 회차 반영 (있을 때만).

    v1(backend/app)과 v2(platform/backend/app)가 같은 최상위 패키지명 'app' 을 쓰기
    때문에 실행 중인 v1 프로세스 안에서 v2 의 app.scheduler.jobs 를 import 하면
    v1 의 app.scheduler(모듈)로 해석돼 "'app.scheduler' is not a package" 로 실패했다.
    → 서브프로세스(cwd=platform/backend)로 격리 실행해 네임스페이스 충돌을 없앤다.
    """
    platform_root = Path(__file__).resolve().parent.parent.parent / "platform" / "backend"
    if not platform_root.is_dir():
        return None
    import json as _json
    import subprocess

    code = (
        "import json\n"
        "from app.scheduler.jobs import sync_csv_incremental\n"
        "print('__V2SYNC__' + json.dumps(sync_csv_incremental(), ensure_ascii=False, default=str))\n"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(platform_root),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-500:]
            return {"ok": False, "error": f"v2 sync subprocess exit {proc.returncode}: {tail}"}
        for line in reversed((proc.stdout or "").strip().splitlines()):
            if line.startswith("__V2SYNC__"):
                return _json.loads(line[len("__V2SYNC__"):])
        return {"ok": False, "error": "v2 sync output marker not found"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
