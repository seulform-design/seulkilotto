"""용지분석 저장소 영구화 — Postgres JSON 블롭 백엔드 (선택).

PHOTO_STORE_DATABASE_URL 이 설정되면 historical/current 저장 dict 를
Postgres 한 테이블(photo_store)에 JSONB 블롭으로 보관한다. 미설정이면
store.py 가 기존 SQLite/JSON 파일 경로로 폴백한다(컨테이너 내부, 휘발).

전용 env 를 쓰는 이유: v2 플랫폼(SQLAlchemy DATABASE_URL)과 분리해
서로의 동작을 건드리지 않기 위함.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

_TABLE = "photo_store"


def _raw_url() -> str:
    return (os.environ.get("PHOTO_STORE_DATABASE_URL") or "").strip()


def enabled() -> bool:
    url = _raw_url()
    return url.startswith("postgres://") or url.startswith("postgresql")


def status() -> Dict[str, Any]:
    """저장 백엔드 진단 — Postgres 설정·연결 여부 확인용 (비밀번호 미노출)."""
    if not enabled():
        return {
            "backend": "file",
            "persistent": False,
            "configured": False,
            "detail": "PHOTO_STORE_DATABASE_URL 미설정 — 컨테이너 내부 저장(재배포 시 초기화).",
        }
    info: Dict[str, Any] = {"backend": "postgres", "configured": True}
    try:
        conn = _connect()
        try:
            _ensure_table(conn)
            with conn.cursor() as cur:
                cur.execute(f"SELECT scope, char_length(payload::text) FROM {_TABLE}")
                rows = cur.fetchall()
        finally:
            conn.close()
        info["persistent"] = True
        info["connected"] = True
        info["scopes"] = {str(r[0]): int(r[1]) for r in rows}
        info["detail"] = "Postgres 연결 정상 — 데이터가 재배포에도 보존됩니다."
    except Exception as exc:  # noqa: BLE001
        info["persistent"] = False
        info["connected"] = False
        info["error"] = str(exc)[:200]
        info["detail"] = "PHOTO_STORE_DATABASE_URL 설정됨 but 연결 실패 — URL/네트워크 확인 필요."
    return info


def _normalized_url() -> str:
    """psycopg2 가 받는 형식으로 정규화 (SQLAlchemy 방언 접미사 제거)."""
    url = _raw_url()
    if url.startswith("postgresql+psycopg2://"):
        url = "postgresql://" + url[len("postgresql+psycopg2://"):]
    elif url.startswith("postgres://"):
        # psycopg2 는 둘 다 받지만 표준화
        url = "postgresql://" + url[len("postgres://"):]
    return url


def _connect():
    import psycopg2  # 지연 임포트 — 미사용 환경에서 임포트 비용/실패 회피

    return psycopg2.connect(_normalized_url(), connect_timeout=10)


def _ensure_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {_TABLE} (
                scope TEXT PRIMARY KEY,
                payload JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    conn.commit()


def load(scope: str) -> Optional[Dict[str, Any]]:
    """scope('historical'|'current') 블롭 로드. 없으면 None."""
    conn = _connect()
    try:
        _ensure_table(conn)
        with conn.cursor() as cur:
            cur.execute(f"SELECT payload FROM {_TABLE} WHERE scope = %s", (scope,))
            row = cur.fetchone()
        if not row or row[0] is None:
            return None
        payload = row[0]
        if isinstance(payload, (str, bytes, bytearray)):
            payload = json.loads(payload)
        return payload if isinstance(payload, dict) else None
    finally:
        conn.close()


def save(scope: str, payload: Dict[str, Any]) -> None:
    """scope 블롭 upsert."""
    blob = json.dumps(payload, ensure_ascii=False)
    conn = _connect()
    try:
        _ensure_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {_TABLE} (scope, payload, updated_at)
                VALUES (%s, %s::jsonb, now())
                ON CONFLICT (scope) DO UPDATE SET
                    payload = EXCLUDED.payload,
                    updated_at = now()
                """,
                (scope, blob),
            )
        conn.commit()
    finally:
        conn.close()
