"""StatisticsSnapshot 파일 히스토리 스토어.

기존 스냅샷을 삭제하지 않고 누적한다. 추천 점수에 연결하지 않는다.
경로: backend/data/statistics_snapshots/
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .statistics_snapshot import SNAPSHOT_VERSION

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
SNAPSHOT_DIR = DATA_DIR / "statistics_snapshots"
_SAFE_TS = re.compile(r"[^0-9T]")


def _ensure_dir() -> Path:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    return SNAPSHOT_DIR


def persist_snapshot(snap: dict[str, Any], *, tag: str | None = None) -> dict[str, Any]:
    """스냅샷을 JSON 파일로 저장. 기존 파일은 덮어쓰지 않음(타임스탬프 키)."""
    _ensure_dir()
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%SZ")
    suffix = f"_{tag}" if tag else ""
    name = f"snapshot_{SNAPSHOT_VERSION}_{ts}{suffix}.json"
    path = SNAPSHOT_DIR / name
    # 충돌 시 접미 추가 (삭제 금지 원칙)
    n = 0
    while path.exists():
        n += 1
        path = SNAPSHOT_DIR / f"snapshot_{SNAPSHOT_VERSION}_{ts}{suffix}_{n}.json"

    payload = dict(snap)
    payload["persisted_at"] = now.isoformat()
    payload["persist_path"] = str(path.name)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "filename": path.name,
        "path": str(path),
        "version": SNAPSHOT_VERSION,
        "persisted_at": payload["persisted_at"],
    }


def list_snapshots(limit: int = 50) -> dict[str, Any]:
    """최신순 스냅샷 메타 목록. 본문은 포함하지 않음."""
    _ensure_dir()
    files = sorted(SNAPSHOT_DIR.glob("snapshot_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    items = []
    for p in files[: max(1, min(int(limit), 200))]:
        meta: dict[str, Any] = {
            "filename": p.name,
            "size_bytes": p.stat().st_size,
            "mtime": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
        }
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            meta["version"] = raw.get("version")
            meta["rounds_count"] = (raw.get("source") or {}).get("rounds", {}).get("count")
            meta["created_at"] = raw.get("created_at") or raw.get("persisted_at")
        except (OSError, json.JSONDecodeError, TypeError):
            meta["parse_error"] = True
        items.append(meta)
    return {
        "ok": True,
        "dir": str(SNAPSHOT_DIR),
        "count": len(items),
        "total_files": len(files),
        "items": items,
        "honesty": "히스토리 스토어는 재현용 아카이브이며 추천 점수에 연결되지 않습니다.",
    }


def load_snapshot(filename: str) -> dict[str, Any] | None:
    """파일명으로 스냅샷 본문 로드. 경로 탈출 방지."""
    base = Path(filename).name
    if not base.startswith("snapshot_") or not base.endswith(".json"):
        return None
    path = SNAPSHOT_DIR / base
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
