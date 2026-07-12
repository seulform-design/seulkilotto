"""복기(review) 슬라이스 회차 정합성 — 엔트리 회차 기준으로 당첨 대조.

회귀 방지: 슬라이스 헤더/당첨 템플릿을 live latest_round 로 재계산하면, 저장 이후
새 추첨이 발표됐을 때 지난 회차 복기 용지를 '다른 회차' 당첨번호와 대조하는
치명적 오류가 난다(예: 1231 용지를 1232 당첨과 비교).
"""
from app.video_analysis import store


def _mk_entry(ticket_round: int) -> dict:
    return {
        "id": f"e{ticket_round}",
        "video_intent": "review",
        "ticket_round": str(ticket_round),
        "result": {},
    }


def test_review_round_from_entries_picks_max():
    entries = [_mk_entry(1230), _mk_entry(1231), _mk_entry(1231)]
    assert store._review_round_from_entries(entries) == 1231


def test_review_round_from_entries_empty_is_none():
    assert store._review_round_from_entries([]) is None
    # ticket_round 없는 엔트리는 '미확인' → 무효 → None
    assert store._review_round_from_entries([{"video_intent": "review", "result": {}}]) is None


def test_build_intent_slice_uses_entry_round_not_live_latest(monkeypatch):
    """복기 슬라이스의 ticket_round·draw_template 는 엔트리 회차(1231)여야 한다.

    live latest_round(1232) 로 오염되면 회귀.
    """
    calls: list = []

    def fake_build_draw_review_template(round_no=None):
        calls.append(round_no)
        rnd = int(round_no or 9999)
        return {
            "source": "official_draw",
            "ticket_round": str(rnd),
            "winning_numbers": [1, 2, 3, 4, 5, 6],
            "bonus": 7,
            "marked_numbers": [1, 2, 3, 4, 5, 6],
        }

    # live 값은 1232(새 추첨 발표됨) — 엔트리는 1231.
    monkeypatch.setattr(store, "_review_round_from_entries", store._review_round_from_entries)
    import app.video_analysis.draw_template as dt

    monkeypatch.setattr(dt, "build_draw_review_template", fake_build_draw_review_template)
    monkeypatch.setattr(dt, "get_review_round_no", lambda: 1232)
    monkeypatch.setattr(dt, "get_current_round_no", lambda: 1233)
    monkeypatch.setattr(store, "get_photo_review_template", lambda: {"marked_numbers": []})
    # combo/accumulate 는 빈 결과로 단순화(회차 정합성만 검증).
    monkeypatch.setattr(store, "_recompute_intent_combo", lambda *a, **k: {"summary": "", "pair_duplicates": [], "triple_duplicates": []})
    monkeypatch.setattr(store, "_accumulate_entries", lambda g: {"final_predictions": {"strong_candidates": [], "excluded_candidates": []}})
    monkeypatch.setattr(store, "_entries_summary_for", lambda g: [])
    monkeypatch.setattr(store, "_manual_saved_lines", lambda g, t: [])

    entries = [_mk_entry(1231), _mk_entry(1231)]
    slice_out = store._build_intent_slice(entries, "review")

    assert slice_out["ticket_round"] == "1231", "슬라이스 헤더는 엔트리 회차여야 함"
    assert slice_out["draw_template"]["ticket_round"] == "1231", "당첨 템플릿도 엔트리 회차여야 함"
    # build_draw_review_template 가 1231 로 호출됐는지(1232/None 이면 회귀).
    assert 1231 in calls and 1232 not in calls
