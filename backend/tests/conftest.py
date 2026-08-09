"""테스트 공통 픽스처.

모듈 전역 엔진 출력 캐시를 매 테스트 전에 초기화한다. 여러 테스트가 store 를
우회(collect_round_samples 등 monkeypatch)해 서로 다른 데이터를 주입하는데,
그 경우 store_signature() 는 실제(빈) store 만 보므로 값이 변하지 않아 캐시가
이전 테스트 결과로 오염된다. 프로덕션에서는 store_signature 가 실데이터를 반영해
정상 무효화되므로 이 초기화는 테스트 격리 전용이다.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _clear_engine_caches():
    def _clear():
        # engine_cached(store.py) 만 초기화 — 이 세션에서 새로 추가된 프로세스 캐시라
        # store 우회 테스트에서 오염된다. 기존 _FL_CACHE/_PM_CACHE 는 손대지 않는다
        # (원래 전 세션 지속 동작이라 건드리면 다른 테스트의 재계산 순서가 바뀜).
        try:
            from app.video_analysis import store as _store
            _store._ENGINE_CACHE.clear()
        except Exception:
            pass

    _clear()
    yield
    _clear()
