from app.video_analysis.overlap_patterns import (
    accumulate_frequency_patterns,
    build_frequency_overlap_patterns,
)


def test_build_frequency_tiers():
    fop = build_frequency_overlap_patterns({7: 4, 12: 3, 3: 2, 5: 1})
    labels = [t["label"] for t in fop["tiers"]]
    assert "2회이상" in labels
    assert "3회이상" in labels
    assert "4회이상" in labels
    assert "5회이상" not in labels
    tier2 = next(t for t in fop["tiers"] if t["min_count"] == 2)
    assert {x["number"] for x in tier2["items"]} == {3, 7, 12}
    tier3 = next(t for t in fop["tiers"] if t["min_count"] == 3)
    assert {x["number"] for x in tier3["items"]} == {7, 12}


def test_accumulate_frequency():
    entries = [
        {
            "result": {
                "extracted_visual_patterns": {
                    "frequency_overlap_patterns": build_frequency_overlap_patterns({7: 3, 12: 2}),
                }
            }
        },
        {
            "result": {
                "extracted_visual_patterns": {
                    "frequency_overlap_patterns": build_frequency_overlap_patterns({7: 4, 15: 2}),
                }
            }
        },
    ]
    acc = accumulate_frequency_patterns(entries)
    tier2 = next(t for t in acc["tiers"] if t["min_count"] == 2)
    n7 = next(x for x in tier2["items"] if x["number"] == 7)
    assert n7["video_votes"] == 2
    assert n7["max_overlap_count"] == 4
