"""관리 키(UPGRADE_API_KEY) 검사 — 상태를 바꾸는 외부 HTTP 요청 보호.

- 비교는 hmac.compare_digest(타이밍 공격 방지), 키 값은 로그·응답에 남기지 않는다.
- 서버 내부 스케줄러는 HTTP 를 거치지 않고 작업 함수를 직접 호출하므로 이 검사와 무관하다.
- require_admin_key        : 키가 설정돼 있으면 헤더 일치 필요(미설정이면 통과 — 기존 정책).
- require_admin_key_strict : 데이터 삭제처럼 되돌릴 수 없는 작업 — 키 미설정이면 거부(503).
"""
from __future__ import annotations

import hmac
from typing import Optional

from fastapi import Header, HTTPException

from .config import settings


def _configured() -> str:
    return (settings.UPGRADE_API_KEY or "").strip()


def key_matches(provided: Optional[str]) -> bool:
    key = _configured()
    if not key:
        return True
    return bool(provided) and hmac.compare_digest(provided.encode(), key.encode())


def require_admin_key(x_upgrade_key: Optional[str] = Header(default=None, alias="X-Upgrade-Key")) -> None:
    if not key_matches(x_upgrade_key):
        raise HTTPException(status_code=401, detail="X-Upgrade-Key 가 필요합니다.")


def require_admin_key_strict(x_upgrade_key: Optional[str] = Header(default=None, alias="X-Upgrade-Key")) -> None:
    if not _configured():
        raise HTTPException(status_code=503, detail="관리 키(UPGRADE_API_KEY)가 설정되지 않아 삭제 작업을 거부합니다.")
    require_admin_key(x_upgrade_key)
