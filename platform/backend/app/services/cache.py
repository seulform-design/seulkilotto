"""Redis 캐시 (선택)."""
from __future__ import annotations

import json
from typing import Any, Optional

from app.config import settings

_client = None
_failed = False  # 연결 1회 실패 시 재시도 안 함 (매 요청 연결시도/지연 방지)


def get_redis():
    global _client, _failed
    if _client is not None:
        return _client
    if _failed:
        return None
    try:
        import redis

        # ping 성공 후에만 _client 에 할당한다. (과거엔 ping 전에 할당해
        # 두어, 연결 실패 시 다음 호출부터 '깨진 클라이언트'를 반환하고
        # cache_get/set 가 ConnectionError 로 500 을 내던 버그가 있었다.)
        client = redis.from_url(
            settings.REDIS_URL, decode_responses=True, socket_connect_timeout=1
        )
        client.ping()
        _client = client
        return _client
    except Exception:
        _failed = True
        return None


def cache_get(key: str) -> Optional[Any]:
    r = get_redis()
    if not r:
        return None
    try:
        raw = r.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        # Redis 는 선택적 캐시 — 런타임 장애 시 미스로 처리(앱 정상 동작).
        return None


def cache_set(key: str, value: Any, ttl: int | None = None) -> None:
    r = get_redis()
    if not r:
        return
    try:
        r.setex(key, ttl or settings.CACHE_TTL_SEC, json.dumps(value, default=str))
    except Exception:
        return
