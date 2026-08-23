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


@pytest.fixture(autouse=True)
def _protect_history_csv():
    """커밋된 이력 CSV 를 테스트가 변형해도 매 테스트 후 원복 — 회차 관련 테스트
    (round_upgrade 등)가 앞선 테스트의 CSV 변형에 오염돼 순서에 따라 실패하던 문제
    (플래키) 방지. 원복 시 load_history 캐시도 무효화한다.
    """
    from pathlib import Path

    csv = Path(__file__).resolve().parents[1] / "data" / "lotto_history.csv"
    orig = csv.read_bytes() if csv.exists() else None
    try:
        yield
    finally:
        if orig is not None and csv.exists() and csv.read_bytes() != orig:
            csv.write_bytes(orig)
            try:
                from app.database import invalidate_history_cache

                invalidate_history_cache()
            except Exception:
                pass


@pytest.fixture(autouse=True)
def _no_real_round_sync(monkeypatch):
    """테스트가 실제 네트워크 회차 캐치업 스레드를 못 띄우게 막는다.

    round_status()/프론트 진입 경로는 ensure_rounds_synced_async 로 백그라운드
    upgrade_rounds() 스레드를 시작한다. 그 스레드가 실제 크롤(네트워크)과
    _UPGRADE_LOCK 을 붙잡은 채 다음 테스트로 새어들어가, 바로 뒤의
    test_round_upgrade 가 락 보유(in_progress) 때문에 간헐 실패했다(전 세션 내내
    '플래키'로 관측). 프로덕션 동작은 정상이므로 테스트에서만 no-op 로 대체한다.
    """
    def _stub(*_a, **_k):
        return {"started": False, "syncing": False, "reason": "test-stub"}

    try:
        monkeypatch.setattr("app.round_upgrade.ensure_rounds_synced_async", _stub)
    except Exception:
        pass
    yield
