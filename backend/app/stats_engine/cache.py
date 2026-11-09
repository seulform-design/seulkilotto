"""데이터 시그니처 기반 통계 캐시.

보장
----
1. 키 = (namespace, data_signature, params) → 원본이 바뀌면 자동으로 다른 키(무효화).
   과거 회차 정정처럼 최신 회차 번호가 그대로인 변경도 시그니처가 바뀌어 잡힌다.
2. TTL 은 보조 장치일 뿐 정합성은 시그니처가 책임진다(오래된 결과 반환 방지).
3. namespace 로 엔드포인트 간 키 충돌 방지.
4. 키별 락으로 동시 요청이 같은 무거운 계산을 중복 실행하지 않는다(단일 비행).
5. 캐시 계층이 망가져도(예외) builder 를 직접 호출해 결과를 반환한다(안전 폴백).
   builder 자신의 예외는 캐시하지 않고 그대로 호출자에게 전달한다.
6. 캐시는 순수 파생물 — `clear()` 후 재계산하면 동일 결과(결정론적 builder 전제).
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Hashable, Optional, Tuple

logger = logging.getLogger(__name__)

_MAX_ENTRIES = 64
_store: Dict[Tuple[Hashable, ...], Tuple[float, Any]] = {}
_locks: Dict[Tuple[Hashable, ...], threading.Lock] = {}
_guard = threading.Lock()
stats = {"hits": 0, "misses": 0, "errors": 0}

_MISS = object()


def _lookup(key, ttl_sec: float):
    hit = _store.get(key)
    if hit is not None and time.monotonic() - hit[0] < ttl_sec:
        return hit[1]
    return _MISS


def _key_lock(key) -> threading.Lock:
    with _guard:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.Lock()
        return lk


def _save(namespace: str, signature: str, key, value) -> None:
    with _guard:
        # 같은 namespace 의 옛 시그니처 결과는 버린다(데이터 변경 → 즉시 무효화)
        for k in [k for k in _store if k[0] == namespace and k[1] != signature]:
            _store.pop(k, None)
        _store[key] = (time.monotonic(), value)
        if len(_store) > _MAX_ENTRIES:
            oldest = min(_store, key=lambda k: _store[k][0])
            _store.pop(oldest, None)


def cached(namespace: str, signature: str, params: Tuple[Hashable, ...],
           builder: Callable[[], Any], ttl_sec: float = 3600.0) -> Any:
    key = (namespace, signature, *params)
    lock: Optional[threading.Lock] = None
    try:
        v = _lookup(key, ttl_sec)
        if v is not _MISS:
            stats["hits"] += 1
            return v
        lock = _key_lock(key)
    except Exception as exc:  # noqa: BLE001 — 캐시 계층 장애
        stats["errors"] += 1
        logger.warning("stats cache 조회 장애 — 직접 계산: %s", exc)
        return builder()

    with lock:
        v = _lookup(key, ttl_sec)  # 대기 중 다른 요청이 채웠을 수 있음
        if v is not _MISS:
            stats["hits"] += 1
            return v
        stats["misses"] += 1
        value = builder()  # builder 예외는 그대로 전파(캐시하지 않음)
        try:
            _save(namespace, signature, key, value)
        except Exception as exc:  # noqa: BLE001
            stats["errors"] += 1
            logger.warning("stats cache 저장 장애 — 결과는 반환: %s", exc)
        return value


def clear() -> None:
    with _guard:
        _store.clear()
        _locks.clear()


def info() -> Dict[str, Any]:
    return {"entries": len(_store), **stats}
