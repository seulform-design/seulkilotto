"""SQLite 보호 — 온라인 백업 · 무결성 검사 · 레코드 수 비교 · WAL 체크포인트 상태.

원칙
----
- 활성 DB 의 -wal/-shm 파일은 직접 삭제하지 않는다(커밋 안 된 페이지가 WAL 에만 있을 수 있음).
- 백업은 `sqlite3.Connection.backup()` (온라인 백업 API) — 쓰기 중에도 일관된 스냅숏.
- 백업본에 `PRAGMA integrity_check` + 테이블별 레코드 수를 원본과 비교한다.
- WAL 정리는 `PRAGMA wal_checkpoint(PASSIVE)` 로 상태만 확인하는 것이 기본이며,
  `truncate=True` 를 명시할 때만 TRUNCATE 체크포인트(SQLite 가 안전하게 WAL 을 비움)를 수행한다.
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _tables(conn: sqlite3.Connection) -> List[str]:
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def _counts(conn: sqlite3.Connection) -> Dict[str, int]:
    return {t: int(conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]) for t in _tables(conn)}


def file_state(db_path: Path) -> Dict[str, Any]:
    out = {}
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(db_path) + suffix)
        out[p.name] = {"exists": p.exists(), "bytes": p.stat().st_size if p.exists() else 0}
    return out


def backup_and_verify(
    db_path: Path,
    backup_dir: Path,
    *,
    keep: int = 10,
    truncate_wal: bool = False,
) -> Dict[str, Any]:
    """온라인 백업 → 백업 무결성 → 레코드 수 비교 → WAL 체크포인트 상태. 원본은 읽기만 한다."""
    db_path = Path(db_path)
    backup_dir = Path(backup_dir)
    report: Dict[str, Any] = {"db": str(db_path), "started_at": datetime.now(timezone.utc).isoformat()}
    if not db_path.exists():
        report.update(ok=False, error="DB 파일 없음")
        return report
    report["files_before"] = file_state(db_path)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = backup_dir / f"{db_path.stem}.{stamp}.db"

    src = sqlite3.connect(str(db_path), timeout=30)
    try:
        # 1) 연결 확인
        report["journal_mode"] = src.execute("PRAGMA journal_mode").fetchone()[0]
        src_counts = _counts(src)
        report["source_counts"] = src_counts
        # 2) 온라인 백업
        t0 = time.time()
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
        finally:
            dst.close()
        report["backup_path"] = str(dest)
        report["backup_seconds"] = round(time.time() - t0, 3)
        # 5) WAL 체크포인트 상태(PASSIVE: 쓰기 차단 없음) — 필요 시에만 TRUNCATE
        mode = "TRUNCATE" if truncate_wal else "PASSIVE"
        busy, log_frames, ckpt_frames = src.execute(f"PRAGMA wal_checkpoint({mode})").fetchone()
        report["wal_checkpoint"] = {"mode": mode, "busy": busy, "log_frames": log_frames,
                                    "checkpointed_frames": ckpt_frames,
                                    "fully_checkpointed": busy == 0 and log_frames == ckpt_frames}
    finally:
        # 6) 정상 종료
        src.close()

    # 3) 백업 무결성 + 4) 레코드 수 비교
    chk = sqlite3.connect(str(dest))
    try:
        integrity = chk.execute("PRAGMA integrity_check").fetchone()[0]
        bak_counts = _counts(chk)
    finally:
        chk.close()
    report["backup_integrity"] = integrity
    report["backup_counts"] = bak_counts
    mismatches = {t: (src_counts.get(t), bak_counts.get(t)) for t in set(src_counts) | set(bak_counts)
                  if src_counts.get(t) != bak_counts.get(t)}
    report["count_mismatches"] = mismatches
    report["files_after"] = file_state(db_path)
    report["ok"] = integrity == "ok" and not mismatches

    # 오래된 백업 정리(최근 keep 개 유지) — 원본·WAL 은 건드리지 않음
    olds = sorted(backup_dir.glob(f"{db_path.stem}.*.db"))
    for p in olds[:-keep] if keep > 0 else []:
        try:
            p.unlink()
        except OSError:
            pass
    return report


def integrity_only(db_path: Path) -> Dict[str, Any]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    try:
        return {"integrity": conn.execute("PRAGMA integrity_check").fetchone()[0],
                "counts": _counts(conn), "files": file_state(Path(db_path))}
    finally:
        conn.close()


if __name__ == "__main__":  # python -m app.ingest.sqlite_maint <db> <backup_dir>
    import json
    import sys

    db = Path(sys.argv[1])
    bdir = Path(sys.argv[2]) if len(sys.argv) > 2 else db.parent / "backups"
    print(json.dumps(backup_and_verify(db, bdir), ensure_ascii=False, indent=1))
