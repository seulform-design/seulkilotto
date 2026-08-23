"""복기(review) 회차 = 최신 추첨 완료 회차 — 자동 업그레이드.

복기는 '최신 추첨 결과를 대조'하는 탭이다. 새 회차가 추첨되면 복기 당첨번호가
자동으로 최신 회차로 올라가야 한다(예: 1233 추첨 시 1233 당첨번호).

회귀 방지: 한때 복기 회차를 엔트리 stamp(ticket_round)에 pin 한 적이 있는데,
앱이 회차 지연으로 과거 회차를 찍은 엔트리에 묶여 다음 회차가 나와도 복기
당첨번호가 업그레이드되지 않는 버그가 있었다(1231 stamp → 1232 추첨돼도 1231 고정).
반드시 get_review_round_no()(=CSV 최신 회차) 기준이어야 한다.
"""
from app.video_analysis import store


def _mk_entry(ticket_round: int) -> dict:
    return {
        "id": f"e{ticket_round}",
        "video_intent": "review",
        "ticket_round": str(ticket_round),
        "result": {},
    }


def test_review_slice_tracks_latest_drawn_round_not_entry_stamp(monkeypatch):
    """엔트리가 과거 회차(1231)로 stamp 돼 있어도, 복기 슬라이스는 최신 추첨
    회차(1233)의 당첨번호를 써야 한다(자동 업그레이드)."""
    calls: list = []

    def fake_build_draw_review_template(round_no=None):
        calls.append(round_no)
        rnd = int(round_no) if round_no is not None else 1233  # get_review_round_no 상당
        return {
            "source": "official_draw",
            "ticket_round": str(rnd),
            "winning_numbers": [12, 15, 19, 22, 24, 36],
            "bonus": 3,
            "marked_numbers": [12, 15, 19, 22, 24, 36],
        }

    import app.video_analysis.draw_template as dt

    monkeypatch.setattr(dt, "build_draw_review_template", fake_build_draw_review_template)
    monkeypatch.setattr(dt, "get_review_round_no", lambda: 1233)   # 최신 추첨 회차
    monkeypatch.setattr(dt, "get_current_round_no", lambda: 1234)
    monkeypatch.setattr(store, "get_photo_review_template", lambda: {"marked_numbers": []})
    monkeypatch.setattr(store, "_recompute_intent_combo", lambda *a, **k: {"summary": "", "pair_duplicates": [], "triple_duplicates": []})
    monkeypatch.setattr(store, "_accumulate_entries", lambda g: {"final_predictions": {"strong_candidates": [], "excluded_candidates": []}})
    monkeypatch.setattr(store, "_entries_summary_for", lambda g: [])
    # **kw 로 받아야 include_photo 등 키워드 인자 추가에도 스텁이 깨지지 않는다.
    monkeypatch.setattr(store, "_manual_saved_lines", lambda g, t, **kw: [])

    # 엔트리는 과거 회차(1231) stamp — 지연으로 잘못 찍힌 경우를 모사.
    entries = [_mk_entry(1231), _mk_entry(1231)]
    slice_out = store._build_intent_slice(entries, "review")

    assert slice_out["ticket_round"] == "1233", "복기 헤더는 최신 추첨 회차여야 함"
    assert slice_out["draw_template"]["ticket_round"] == "1233"
    # build_draw_review_template 은 인자 없이(=최신 회차) 호출돼야 함(회차 pin 금지).
    assert calls == [None], f"draw_template 은 최신 회차로 호출돼야 함, got {calls}"
