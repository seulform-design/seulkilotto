"""Redis 캐시 (선택)."""
from __future__ import annotations

import json
from typing import Any, Optional

from app.config import settings

_client = None


def get_redis():
    global _client
    if _client is not None:
        return _client
    try:
        import redis

        _client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        _client.ping()
        return _client
    except Exception:
        return None


def cache_get(key: str) -> Optional[Any]:
    r = get_redis()
    if not r:
        return None
    raw = r.get(key)
    return json.loads(raw) if raw else None


def cache_set(key: str, value: Any, ttl: int | None = None) -> None:
    r = get_redis()
    if not r:
        return
    r.setex(key, ttl or settings.CACHE_TTL_SEC, json.dumps(value, default=str))
