from app.video_analysis.combo_patterns import analyze_current_round_sheet_combos


def _details(*sheet_nums):
    return [{"numbers": list(nums), "mark_scores": {str(n): 2 for n in nums}} for nums in sheet_nums]


def test_current_round_line_cross_pairs_and_triples():
    details = _details({7, 12, 24}, {7, 12, 30}, {7, 12, 24, 35}, {3, 7, 12})
    out = analyze_current_round_sheet_combos(sheet_details=details)
    pair_nums = [tuple(x["numbers"]) for x in out["pair_duplicates"]]
    assert (7, 12) in pair_nums
    hit = next(x for x in out["pair_duplicates"] if x["numbers"] == [7, 12])
    assert hit["repeat_count"] >= 2
    assert hit.get("sheet_indices")

    triple_nums = [tuple(x["numbers"]) for x in out["triple_duplicates"]]
    assert (7, 12, 24) in triple_nums
    triple_hit = next(x for x in out["triple_duplicates"] if x["numbers"] == [7, 12, 24])
    assert triple_hit["repeat_count"] >= 2


def test_pair_only_two_sheets():
    details = _details({1, 2, 3}, {1, 2, 4}, {9, 10})
    out = analyze_current_round_sheet_combos(sheet_details=details)
    assert any(x["numbers"] == [1, 2] for x in out["pair_duplicates"])
    assert not out["triple_duplicates"]


def test_large_batch_filters_noise_candidates():
    """많은 줄에서 후보는 많아도, 적응형 기준으로 축소."""
    base = {7, 12, 24}
    details = _details(*[set(base) | {i} for i in range(1, 25)])
    out = analyze_current_round_sheet_combos(sheet_details=details)
    ver = out.get("combo_verification") or {}
    assert ver.get("pair_min_repeat", 2) >= 3
    assert ver.get("raw_pair_candidates", 0) >= len(out.get("pair_duplicates") or [])
