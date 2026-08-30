"""복기(review) 회차 대조 규칙.

두 경우를 구분한다:

1) **현 회차 데이터가 있으면(archived/review_saved) → 최신 추첨 회차 기준.**
   복기는 '최신 추첨 결과를 대조'하는 탭이라, 그 회차에 귀속된 용지가 있으면
   당첨번호가 자동으로 최신 회차로 올라가야 한다(예: 1233 추첨 시 1233 당첨번호).

2) **현 회차 데이터가 하나도 없고 지난 회차 용지만 있으면(legacy_all) → 그 용지의
   실제(우세) 회차 기준.** 예전에는 이 경우에도 최신 회차로 강제 라벨·대조해서,
   실제로는 1237 용지인데 1238 당첨번호와 대조돼 '거의 다 안 맞는 것처럼' 보였다
   (실증 버그). 미등록으로 지나간 회차가 있어도 지난 용지는 자기 회차로 대조해야 한다.
"""
from app.video_analysis import store


def _mk_entry(ticket_round: int) -> dict:
    return {
        "id": f"e{ticket_round}",
        "video_intent": "review",
        "ticket_round": str(ticket_round),
        "result": {},
    }


def _patch_common(monkeypatch, calls):
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


def test_review_slice_uses_latest_round_when_current_round_data_exists(monkeypatch):
    """현 회차(1233)에 귀속된 복기 용지가 있으면 최신 추첨 회차(1233)로 대조한다
    (자동 업그레이드 — 지연 stamp 방어)."""
    calls: list = []
    _patch_common(monkeypatch, calls)
    # 최신 회차(1233)에 귀속된 review_saved 엔트리가 존재 → legacy_all 이 아니다.
    monkeypatch.setattr(store, "_review_entries_for_round", lambda r: ([], [_mk_entry(1233)]))

    entries = [_mk_entry(1233)]
    slice_out = store._build_intent_slice(entries, "review")

    assert slice_out["ticket_round"] == "1233", "현 회차 데이터가 있으면 최신 추첨 회차 기준"
    assert slice_out["draw_template"]["ticket_round"] == "1233"
    assert calls == [1233], f"draw_template 은 최신 회차로 호출돼야 함, got {calls}"


def test_review_slice_legacy_only_compares_against_its_own_round(monkeypatch):
    """현 회차(1233)에 귀속된 용지가 없고 지난 회차(1237) 용지만 있으면(legacy_all),
    그 용지는 자기 회차(1237) 당첨번호와 대조해야 한다 — 최신(1233)으로 강제 금지.

    회귀 방지: 1237 용지가 1238 로 표시·대조돼 '안 맞는 것처럼' 보이던 실제 사고.
    """
    calls: list = []
    _patch_common(monkeypatch, calls)
    # 최신 회차(1233)에 귀속된 용지 없음 → legacy_all 폴백.
    monkeypatch.setattr(store, "_review_entries_for_round", lambda r: ([], []))

    # 지난 회차(1237) stamp 용지만 있다(미등록으로 최신까지 밀린 상태).
    entries = [_mk_entry(1237), _mk_entry(1237)]
    slice_out = store._build_intent_slice(entries, "review")

    assert slice_out["ticket_round"] == "1237", "지난 용지는 자기 회차로 대조해야 함"
    assert slice_out["draw_template"]["ticket_round"] == "1237"
    assert calls == [1237], f"draw_template 은 용지의 실제 회차로 호출돼야 함, got {calls}"


def test_review_slice_legacy_dominant_round_wins(monkeypatch):
    """legacy_all 에 여러 회차가 섞이면 우세(최다) 회차를 쓴다(펜딩/미추첨 회차)."""
    calls: list = []
    _patch_common(monkeypatch, calls)
    monkeypatch.setattr(store, "_review_entries_for_round", lambda r: ([], []))

    entries = [_mk_entry(1237), _mk_entry(1237), _mk_entry(1235)]
    slice_out = store._build_intent_slice(entries, "review")

    assert slice_out["ticket_round"] == "1237", "우세 회차(1237)로 대조"
    assert calls == [1237]


def test_review_slice_stale_legacy_advances_to_latest_unregistered(monkeypatch):
    """지난(이미 추첨된) 회차 용지만 있고 최신 추첨 회차는 미등록이면,
    옛 회차로 되돌리지 않고 최신 추첨 회차(1233)로 '미등록' 빈 상태로 진행한다.

    사용자 실증: 1236 등록 후 1237·1238 이 추첨됐는데 1237/1238 미등록.
    복기가 계속 1236 으로 되돌아가던 문제 → 최신 회차 미등록 상태 유지로 교정.
    (지난 회차 용지는 [비교 회차]·[백필] 선택 시 자기 회차로 정확히 대조.)
    """
    calls: list = []
    _patch_common(monkeypatch, calls)
    # 최신 추첨 회차(1233)에 귀속된 용지 없음 → 폴백. 등록 용지는 지난 회차(1231)뿐.
    monkeypatch.setattr(store, "_review_entries_for_round", lambda r: ([], []))

    entries = [_mk_entry(1231), _mk_entry(1231)]
    slice_out = store._build_intent_slice(entries, "review")

    assert slice_out["ticket_round"] == "1233", "미등록 최신 회차로 진행(옛 회차로 되돌림 금지)"
    assert slice_out["total_analyses"] == 0, "미등록 = 빈 상태"
    rs = slice_out["round_sources"]
    assert rs["primary"] == "unregistered_latest"
    assert rs["unregistered_latest"] is True
    assert rs["latest_registered_review_round"] == 1231, "지난 등록 회차를 안내용으로 노출"
    assert calls == [1233], "당첨 템플릿은 최신 추첨 회차로 호출"
