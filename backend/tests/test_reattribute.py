"""복기 엔트리 회차 재귀속(관리자 도구) — 비파괴 교정 검증.

저장 시점의 '최신 추첨 회차' 로 잘못 stamp 된 복기 엔트리를 실제 회차로 되돌린다.
삭제 없이 라벨만 교정하고, 원본 회차는 original_ticket_round 에 보존한다.
롤오버 보관 정본(archived_current_rounds)은 절대 건드리지 않는다.
"""
import pytest

from app.video_analysis.store import (
    _load_historical_raw,
    _save_historical_raw,
    reattribute_review_entries,
)


@pytest.fixture(autouse=True)
def _isolated_store(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.datasets.current.CURRENT_DIR", tmp_path / "current")
    monkeypatch.setattr("app.datasets.current.STATE_PATH", tmp_path / "current" / "state.json")
    monkeypatch.setattr("app.datasets.current.PHOTO_PATH", tmp_path / "current" / "photo.json")
    monkeypatch.setattr("app.datasets.current.DERIVED_PATH", tmp_path / "current" / "derived.json")


def _seed(entries, archived=None):
    data = _load_historical_raw()
    data["entries"] = entries
    data["archived_current_rounds"] = archived or []
    _save_historical_raw(data)


def _review(eid, rnd):
    return {"id": eid, "video_intent": "review", "ticket_round": str(rnd), "result": {}}


def test_reattributes_and_preserves_original():
    _seed([_review("a", 1233), _review("b", 1233), _review("c", 1231)])
    res = reattribute_review_entries(from_round=1233, to_round=1232)
    assert res["ok"] is True
    assert res["changed"] == 2

    entries = {e["id"]: e for e in (_load_historical_raw().get("entries") or [])}
    assert entries["a"]["ticket_round"] == "1232"
    assert entries["a"]["original_ticket_round"] == "1233"  # 원본 보존(되돌리기 가능)
    assert entries["b"]["ticket_round"] == "1232"
    assert entries["c"]["ticket_round"] == "1231"  # 대상 아님 — 불변
    # 삭제 없음
    assert len(entries) == 3


def test_does_not_touch_archived_batches():
    """롤오버 보관 정본은 '추첨 전 등록' 이라 소속이 확실 → 절대 변경 금지."""
    archived = [
        {"round_no": 1233, "entries": [{"id": "arch1", "video_intent": "current_round", "ticket_round": "1233"}]}
    ]
    _seed([_review("a", 1233)], archived=archived)
    reattribute_review_entries(from_round=1233, to_round=1232)

    data = _load_historical_raw()
    batch = data["archived_current_rounds"][0]
    assert batch["round_no"] == 1233
    assert batch["entries"][0]["ticket_round"] == "1233"  # 불변
    assert batch["entries"][0]["video_intent"] == "current_round"  # 재태깅 persist 안 됨


def test_entry_ids_filter():
    _seed([_review("a", 1233), _review("b", 1233)])
    res = reattribute_review_entries(from_round=1233, to_round=1232, entry_ids=["a"])
    assert res["changed"] == 1
    entries = {e["id"]: e for e in (_load_historical_raw().get("entries") or [])}
    assert entries["a"]["ticket_round"] == "1232"
    assert entries["b"]["ticket_round"] == "1233"


def test_noop_when_no_match():
    _seed([_review("a", 1231)])
    res = reattribute_review_entries(from_round=1233, to_round=1232)
    assert res["ok"] is False
    assert res["changed"] == 0
    # 저장소 불변
    assert (_load_historical_raw().get("entries") or [])[0]["ticket_round"] == "1231"


def test_same_round_rejected():
    _seed([_review("a", 1233)])
    res = reattribute_review_entries(from_round=1233, to_round=1233)
    assert res["ok"] is False


def test_delete_entry_reaches_archived_batches():
    """복기 탭이 보관 배치를 정본으로 '표시' 하므로 그 엔트리도 삭제 가능해야 한다.
    (구버전은 historical/current 만 훑어 화면의 엔트리가 404 로 삭제 불가였다.)"""
    from app.video_analysis.store import delete_entry

    archived = [
        {
            "round_no": 1233,
            "entries": [
                {"id": "arch1", "video_intent": "current_round", "ticket_round": "1233"},
                {"id": "arch2", "video_intent": "current_round", "ticket_round": "1233"},
            ],
        }
    ]
    _seed([], archived=archived)
    assert delete_entry("arch1") is True
    batch = _load_historical_raw()["archived_current_rounds"][0]
    assert [e["id"] for e in batch["entries"]] == ["arch2"]
    # 마지막 엔트리를 지우면 빈 배치는 통째로 제거
    assert delete_entry("arch2") is True
    assert _load_historical_raw()["archived_current_rounds"] == []
    assert delete_entry("nope") is False


def test_clear_review_include_archived():
    """복기 전체 삭제가 보관 배치까지 도달해야 화면에서 실제로 사라진다."""
    from app.video_analysis.store import clear_store_intent

    archived = [
        {"round_no": 1233, "entries": [{"id": "a1", "video_intent": "current_round", "ticket_round": "1233"}]}
    ]
    _seed([_review("r1", 1233)], archived=archived)

    # 기본(include_archived=False) — 보관 배치는 보존
    removed = clear_store_intent("review")
    assert removed == 1
    assert len(_load_historical_raw()["archived_current_rounds"]) == 1

    # 명시 요청 시에만 보관 배치까지 정리
    _seed([_review("r2", 1233)], archived=archived)
    removed2 = clear_store_intent("review", include_archived=True)
    assert removed2 == 2  # live 1 + archived 1
    assert _load_historical_raw()["archived_current_rounds"] == []


def test_reattribute_twice_keeps_first_original():
    _seed([_review("a", 1233)])
    reattribute_review_entries(from_round=1233, to_round=1232)
    reattribute_review_entries(from_round=1232, to_round=1230)
    e = (_load_historical_raw().get("entries") or [])[0]
    assert e["ticket_round"] == "1230"
    assert e["original_ticket_round"] == "1233"  # 최초 원본 유지
