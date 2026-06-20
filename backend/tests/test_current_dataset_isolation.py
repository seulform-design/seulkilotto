from app.video_analysis.store import (
    append_analysis,
    build_accumulated,
    clear_store,
    clear_store_intent,
    get_current_dataset_state,
    get_historical_dataset_state,
    record_current_rule_engine_output,
    rollover_current_dataset,
)


def _result(image_id: str, intent: str, round_no: str, numbers: list[int]) -> dict:
    return {
        "video_visual_analysis": {
            "video_id": image_id,
            "video_title": image_id,
            "ticket_round": round_no,
            "detected_round": round_no,
            "video_intent": intent,
            "video_intent_label": "복기" if intent == "review" else "이번회차",
        },
        "extracted_visual_patterns": {},
        "final_predictions": {"strong_candidates": numbers, "excluded_candidates": []},
        "meta": {
            "sheet_intent": intent,
            "sheet_number_sets": [numbers],
            "photo_review_template": {
                "source": "photo_review",
                "ticket_round": round_no,
                "marked_numbers": numbers,
                "positions": {},
                "combo_patterns": {"pair_duplicates": [], "triple_duplicates": []},
            },
        },
        "app_ui_message": "test",
    }


def test_current_and_historical_datasets_are_isolated(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.video_analysis.draw_template.get_current_round_no", lambda: 1227)
    monkeypatch.setattr("app.video_analysis.draw_template.get_review_round_no", lambda: 1226)
    clear_store()

    append_analysis("review-a", _result("review-a", "review", "1226", [1, 2, 3, 4, 5, 6]))
    append_analysis("current-a", _result("current-a", "current_round", "1227", [7, 8, 9, 10, 11, 12]))

    historical = get_historical_dataset_state()
    current = get_current_dataset_state()
    acc = build_accumulated()

    assert len(historical["entries"]) == 1
    assert len(current["entries"]) == 1
    assert set(acc["by_intent"]["review"]["final_predictions"]["strong_candidates"]) == {1, 2, 3, 4, 5, 6}
    assert set(acc["by_intent"]["current_round"]["final_predictions"]["strong_candidates"]) == {7, 8, 9, 10, 11, 12}
    assert acc["current_dataset"]["round_no"] == 1227


def test_current_rule_outputs_archive_idempotently(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.video_analysis.draw_template.get_current_round_no", lambda: 1227)
    monkeypatch.setattr("app.video_analysis.draw_template.get_review_round_no", lambda: 1226)
    clear_store()

    append_analysis("current-a", _result("current-a", "current_round", "1227", [7, 8, 9, 10, 11, 12]))
    assert record_current_rule_engine_output(
        "round_recommendation",
        round_no=1227,
        latest_round=1226,
        payload={"combinations": [{"numbers": [1, 2, 3, 4, 5, 6]}]},
        rule_snapshot={"filter_rule": "x", "compose_rule": "y"},
    )

    rollover = rollover_current_dataset(
        drawn_round=1227,
        next_round=1228,
        winning_numbers=[1, 2, 3, 4, 5, 6],
        bonus=7,
    )
    assert rollover["rolled_over"] is True

    current = get_current_dataset_state()
    historical = get_historical_dataset_state()
    assert current["current_round"] == 1228
    assert current["entries"] == []
    assert len(historical["archived_current_rounds"]) == 1
    archived = historical["archived_current_rounds"][0]
    assert archived["round_no"] == 1227
    assert archived["backtest"]["engine_results"]["round_recommendation"]["best_hit"] == 6
    acc = build_accumulated()
    archived_snapshot = acc["historical_dataset"]["latest_archived_current_snapshot"]
    assert archived_snapshot["archived"] is True
    assert archived_snapshot["round_no"] == 1227
    assert archived_snapshot["final_predictions"]["strong_candidates"] == [7, 8, 9, 10, 11, 12]

    rollover_again = rollover_current_dataset(
        drawn_round=1227,
        next_round=1228,
        winning_numbers=[1, 2, 3, 4, 5, 6],
        bonus=7,
    )
    assert rollover_again["ok"] is True
    assert rollover_again["rolled_over"] is False
    assert rollover_again["reason"] == "already_archived"


def test_clear_store_intent_only_clears_target_slice(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.video_analysis.draw_template.get_current_round_no", lambda: 1227)
    monkeypatch.setattr("app.video_analysis.draw_template.get_review_round_no", lambda: 1226)
    clear_store()

    append_analysis("review-a", _result("review-a", "review", "1226", [1, 2, 3, 4, 5, 6]))
    append_analysis("current-a", _result("current-a", "current_round", "1227", [7, 8, 9, 10, 11, 12]))

    removed_review = clear_store_intent("review")
    assert removed_review == 1
    acc = build_accumulated()
    assert acc["by_intent"]["review"]["total_analyses"] == 0
    assert acc["by_intent"]["current_round"]["total_analyses"] == 1

    removed_current = clear_store_intent("current_round")
    assert removed_current == 1
    acc2 = build_accumulated()
    assert acc2["by_intent"]["current_round"]["total_analyses"] == 0
