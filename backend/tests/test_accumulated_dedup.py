import pytest

from app.video_analysis.store import (
    _accumulate_combo_patterns,
    append_analysis,
    build_accumulated,
    clear_store,
)


def _result_with_sheets(
    image_id: str,
    intent: str,
    round_no: str,
    sheet_sets: list[list[int]],
) -> dict:
    return {
        "video_visual_analysis": {
            "video_id": image_id,
            "video_title": f"batch-{image_id}",
            "ticket_round": round_no,
            "detected_round": round_no,
            "video_intent": intent,
            "video_intent_label": "복기" if intent == "review" else "이번회차",
        },
        "extracted_visual_patterns": {
            "combo_patterns": {
                "pair_duplicates": [],
                "triple_duplicates": [],
            }
        },
        "final_predictions": {"strong_candidates": [], "excluded_candidates": []},
        "meta": {
            "sheet_intent": intent,
            "sheet_number_sets": sheet_sets,
            "images_analyzed": len(sheet_sets),
        },
        "app_ui_message": "test",
    }


def test_accumulated_combo_not_explodes(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()

    # 1226 당첨번호 일부 + 잡번호가 많은 용지 → 일반 C(n,2)면 수백 건, 당첨조합은 소수
    winning = [4, 6, 13, 17, 26, 28]
    noisy = list(range(1, 16))
    sheets = [winning, winning[:3] + noisy[:5], noisy, noisy[:10]]
    r1 = _result_with_sheets("batch-a", "review", "1226", sheets)
    append_analysis("batch-a", r1, source_label="a.png")

    acc = _accumulate_combo_patterns([{"result": r1}])
    pairs = acc.get("pair_duplicates") or []
    triples = acc.get("triple_duplicates") or []
    assert len(pairs) <= 15
    assert len(triples) <= 20


def test_replace_same_source_instead_of_duplicate(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()

    r1 = _result_with_sheets("same-id", "review", "1226", [[4, 6, 13, 17, 26, 28]])
    r2 = _result_with_sheets("same-id", "review", "1226", [[4, 6, 13, 17, 26, 28], [4, 6, 13]])
    append_analysis("same-id", r1, replace_existing=True)
    append_analysis("same-id", r2, replace_existing=True)

    acc = build_accumulated()
    assert acc["total_analyses"] == 1
    assert acc["by_intent"]["review"]["total_analyses"] == 1
    assert acc["by_intent"]["current_round"]["total_analyses"] == 0
