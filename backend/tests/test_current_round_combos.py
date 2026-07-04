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


def test_large_batch_shows_all_and_annotates_significance():
    """대량이어도 겹침은 2줄+ 전체 노출(사용자 요청). 노이즈 축소는 '표시'가
    아니라 '강한후보 신호(우연 대비 초과)'에서 처리한다."""
    base = {7, 12, 24}
    details = _details(*[set(base) | {i} for i in range(1, 25)])
    out = analyze_current_round_sheet_combos(sheet_details=details)
    ver = out.get("combo_verification") or {}
    # 표시는 최소 2줄까지 모두
    assert ver.get("pair_min_repeat") == 2
    # 각 조합에 우연 대비 초과(expected/lift/z) 주석이 붙는다
    pairs = out.get("pair_duplicates") or []
    assert pairs and all("lift" in p and "z" in p and "expected" in p for p in pairs)
    # 강한후보 신호는 유의 조합만 반영(표시보다 작거나 같음)
    assert ver.get("signal_pairs", 0) <= len(pairs)
