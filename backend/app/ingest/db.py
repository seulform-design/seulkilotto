"""자동 수집 파이프라인 저장소 — SQLite(로컬) / Postgres(운영) 공용 얇은 어댑터.

- 운영(Railway): PHOTO_STORE_DATABASE_URL(Postgres, 재배포에도 영구) 에 `reg_*` 테이블을 **추가**한다.
  기존 `photo_store` 테이블은 읽지도 쓰지도 않는다(기존 DB 보호).
- 로컬/테스트: backend/data/draw_registry.db (SQLite, WAL). `INGEST_DB_PATH` 로 재지정 가능.

스키마 버전은 reg_schema 테이블로 관리(마이그레이션은 이 파일 = Git 관리). 모든 쓰기는
`transaction()` 컨텍스트에서 원자적으로 수행되며 예외 시 롤백된다.
"""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence

SCHEMA_VERSION = 2
_DATA_DIR = Path(__file__).resolve().parents[2] / "data"
_LOCK = threading.RLock()

SCHEMA = [
    # 정식(공식 검증) 회차 — 회차 번호 고유키
    """CREATE TABLE IF NOT EXISTS reg_draws (
        round INTEGER PRIMARY KEY,
        n1 INTEGER NOT NULL, n2 INTEGER NOT NULL, n3 INTEGER NOT NULL,
        n4 INTEGER NOT NULL, n5 INTEGER NOT NULL, n6 INTEGER NOT NULL,
        bonus INTEGER NOT NULL,
        draw_date TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        source TEXT NOT NULL,
        youtube_video_id TEXT,
        prizes_json TEXT,
        first_collected_at TEXT NOT NULL,
        last_verified_at TEXT,
        data_version INTEGER NOT NULL DEFAULT 1
    )""",
    # 검증 대기/불일치/미검증 — 정식 테이블과 분리
    """CREATE TABLE IF NOT EXISTS reg_staging (
        id TEXT PRIMARY KEY,
        round INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
    )""",
    # 변경 이력(append-only)
    """CREATE TABLE IF NOT EXISTS reg_history (
        id TEXT PRIMARY KEY,
        round INTEGER NOT NULL,
        action TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        actor TEXT NOT NULL,
        at TEXT NOT NULL
    )""",
    # 유튜브 관측(영상 메타 + 추출 결과)
    """CREATE TABLE IF NOT EXISTS reg_youtube (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT,
        channel_title TEXT,
        title TEXT,
        url TEXT,
        published_at TEXT,
        round INTEGER,
        draw_date TEXT,
        numbers_json TEXT,
        bonus INTEGER,
        text_source TEXT,
        confidence REAL,
        kind TEXT,
        collected_at TEXT NOT NULL
    )""",
    # 작업 실행 기록(재시도·오류 종류 포함)
    """CREATE TABLE IF NOT EXISTS reg_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_kind TEXT,
        error TEXT,
        detail_json TEXT
    )""",
    # 엔진 상태(6종 학습 + 통계 + 백테스트)
    """CREATE TABLE IF NOT EXISTS reg_engines (
        engine TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        input_signature TEXT,
        last_round INTEGER,
        last_run_at TEXT,
        duration_sec REAL,
        summary_json TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        algorithm_version TEXT
    )""",
    # 작업 잠금(중복 실행 방지, 만료 시각으로 고아 잠금 회수)
    """CREATE TABLE IF NOT EXISTS reg_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at REAL NOT NULL
    )""",
    # 회차별 예측 기록(백테스트 저장) — 해당 회차 이전 데이터만으로 생성
    """CREATE TABLE IF NOT EXISTS reg_backtest_log (
        round INTEGER NOT NULL,
        strategy TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        data_first_round INTEGER NOT NULL,
        data_last_round INTEGER NOT NULL,
        predicted_json TEXT NOT NULL,
        actual_json TEXT NOT NULL,
        bonus INTEGER NOT NULL,
        matches INTEGER NOT NULL,
        bonus_match INTEGER NOT NULL,
        prize_rank INTEGER,
        PRIMARY KEY (round, strategy, algorithm_version)
    )""",
    # 유튜브 용지(자동/반자동) 학습 데이터 — 당첨번호 DB 와 별도
    """CREATE TABLE IF NOT EXISTS reg_tickets (
        id TEXT PRIMARY KEY,
        round INTEGER,
        video_id TEXT NOT NULL,
        video_url TEXT NOT NULL,
        frame_ref TEXT NOT NULL,
        pick_type TEXT NOT NULL,
        game_label TEXT,
        numbers_json TEXT NOT NULL,
        manual_numbers_json TEXT,
        ocr_confidence REAL NOT NULL,
        type_confidence REAL NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        purchase_confirmed INTEGER NOT NULL DEFAULT 0,
        collected_at TEXT NOT NULL
    )""",
    # ── 기준(Seed) 영상 기반 용지 수집 (2026-11-10, 스키마 v2) ──
    """CREATE TABLE IF NOT EXISTS youtube_seed_videos (
        seed_id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL UNIQUE,
        video_url TEXT NOT NULL,
        title TEXT,
        channel_id TEXT,
        channel_title TEXT,
        published_at TEXT,
        analysis_status TEXT NOT NULL,
        analysis_json TEXT,
        registered_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS youtube_discovered_videos (
        video_id TEXT PRIMARY KEY,
        source_seed_id TEXT,
        channel_id TEXT,
        channel_title TEXT,
        title TEXT,
        video_url TEXT NOT NULL,
        published_at TEXT,
        similarity_score REAL,
        video_category TEXT,
        duplicate_group_id TEXT,
        collection_status TEXT NOT NULL,
        round_hint INTEGER,
        discovered_via TEXT,
        algorithm_version TEXT,
        discovered_at TEXT NOT NULL,
        processed_at TEXT,
        error TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS youtube_video_frames (
        frame_id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        timestamp TEXT,
        frame_source TEXT NOT NULL,
        frame_hash TEXT NOT NULL,
        ticket_detected INTEGER NOT NULL,
        extraction_status TEXT NOT NULL,
        ticket_round INTEGER,
        lines_found INTEGER,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS ticket_auto_data (
        ticket_id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        frame_id TEXT,
        draw_round INTEGER,
        round_status TEXT NOT NULL,
        game_index TEXT,
        numbers TEXT NOT NULL,
        confidence REAL NOT NULL,
        type_confidence REAL NOT NULL,
        verification_status TEXT NOT NULL,
        observed_only INTEGER NOT NULL DEFAULT 1,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS ticket_semi_auto_data (
        ticket_id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        frame_id TEXT,
        draw_round INTEGER,
        round_status TEXT NOT NULL,
        game_index TEXT,
        selected_numbers TEXT,
        generated_numbers TEXT,
        numbers TEXT NOT NULL,
        confidence REAL NOT NULL,
        type_confidence REAL NOT NULL,
        verification_status TEXT NOT NULL,
        observed_only INTEGER NOT NULL DEFAULT 1,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS ticket_learning_history (
        learning_id TEXT PRIMARY KEY,
        video_id TEXT,
        ticket_id TEXT,
        engine_id TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        learning_status TEXT NOT NULL,
        pick_type TEXT,
        draw_round INTEGER,
        sample_count INTEGER,
        result_json TEXT,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS reg_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    )""",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _pg_url() -> str:
    url = (os.environ.get("PHOTO_STORE_DATABASE_URL") or "").strip()
    if url.startswith("postgresql+psycopg2://"):
        url = "postgresql://" + url[len("postgresql+psycopg2://"):]
    elif url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url if url.startswith("postgresql://") else ""


def backend() -> str:
    if os.environ.get("INGEST_DB_PATH"):
        return "sqlite"
    return "postgres" if _pg_url() else "sqlite"


def sqlite_path() -> Path:
    p = os.environ.get("INGEST_DB_PATH")
    return Path(p) if p else _DATA_DIR / "draw_registry.db"


class _Conn:
    """sqlite3 / psycopg2 공통 인터페이스 — SQL 은 '?' 플레이스홀더로 작성."""

    def __init__(self) -> None:
        self.kind = backend()
        if self.kind == "postgres":
            import psycopg2

            self.raw = psycopg2.connect(_pg_url(), connect_timeout=10)
        else:
            path = sqlite_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            self.raw = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
            self.raw.execute("PRAGMA journal_mode=WAL")
            self.raw.execute("PRAGMA foreign_keys=ON")

    def _sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self.kind == "postgres" else sql

    def execute(self, sql: str, params: Sequence[Any] = ()) -> List[tuple]:
        cur = self.raw.cursor()
        try:
            cur.execute(self._sql(sql), tuple(params))
            try:
                return list(cur.fetchall())
            except Exception:  # noqa: BLE001 — 결과 없는 문장
                return []
        finally:
            cur.close()

    def rowcount(self, sql: str, params: Sequence[Any] = ()) -> int:
        cur = self.raw.cursor()
        try:
            cur.execute(self._sql(sql), tuple(params))
            return int(cur.rowcount or 0)
        finally:
            cur.close()

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        self.raw.close()


_SCHEMA_READY: Dict[str, bool] = {}


def _ensure_schema(conn: _Conn) -> None:
    key = conn.kind + (str(sqlite_path()) if conn.kind == "sqlite" else "")
    if _SCHEMA_READY.get(key):
        return
    for stmt in SCHEMA:
        conn.execute(stmt)
    rows = conn.execute("SELECT version FROM reg_schema WHERE version = ?", (SCHEMA_VERSION,))
    if not rows:
        conn.execute("INSERT INTO reg_schema (version, applied_at) VALUES (?, ?)", (SCHEMA_VERSION, now_iso()))
    conn.commit()
    _SCHEMA_READY[key] = True


@contextlib.contextmanager
def transaction() -> Iterator[_Conn]:
    """원자적 작업 단위 — 예외 시 롤백, 성공 시 커밋."""
    with _LOCK:
        conn = _Conn()
        try:
            _ensure_schema(conn)
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def query(sql: str, params: Sequence[Any] = ()) -> List[tuple]:
    with transaction() as c:
        return c.execute(sql, params)


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, default=str)


def loads(s: Optional[str]) -> Any:
    if s is None:
        return None
    return json.loads(s)


def reset_for_tests() -> None:
    _SCHEMA_READY.clear()


def backup_sqlite(reason: str = "pre-write") -> Optional[Dict[str, Any]]:
    """저장 전 백업 — SQLite 백엔드일 때 온라인 백업(최근 10개 유지). Postgres 는 관리형 백업에 위임."""
    if backend() != "sqlite" or not sqlite_path().exists():
        return None
    from .sqlite_maint import backup_and_verify

    rep = backup_and_verify(sqlite_path(), sqlite_path().parent / "backups" / "registry", keep=10)
    return {"reason": reason, "ok": rep.get("ok"), "path": rep.get("backup_path")}
