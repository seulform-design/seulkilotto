"""자동용지 번호 출현 빈도 패턴 — 2회+/3회+/4회+ 등 계층 분석."""
from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List

TIER_SPECS: List[tuple[int, str, str]] = [
    (5, "5회이상", "오수이상"),
    (4, "4회이상", "사수이상"),
    (3, "3회이상", "삼수이상"),
    (2, "2회이상", "쌍수"),
]


def _get_fop_from_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    r = entry.get("result") or entry
    evp = r.get("extracted_visual_patterns") or {}
    fop = evp.get("frequency_overlap_patterns")
    if fop and fop.get("tiers"):
        return fop
    counts: Counter = Counter()
    for item in (entry.get("triple_plus_overlap") or evp.get("triple_plus_overlap") or {}).get("items") or []:
        try:
            counts[int(item["number"])] = max(counts[int(item["number"])], int(item.get("overlap_count", 3)))
        except (TypeError, ValueError, KeyError):
            pass
    for item in (evp.get("identified_multiples") or {}).get("numbers") or []:
        try:
            n = int(item)
            counts[n] = max(counts[n], 2)
        except (TypeError, ValueError):
            pass
    return build_frequency_overlap_patterns(counts) if counts else build_frequency_overlap_patterns({})


def build_frequency_overlap_patterns(counts: Dict[int, int] | Counter) -> Dict[str, Any]:
    counter = Counter(counts)
    all_frequent = sorted(
        [{"number": int(n), "overlap_count": int(c)} for n, c in counter.items() if c >= 2],
        key=lambda x: (-x["overlap_count"], x["number"]),
    )

    tiers: List[Dict[str, Any]] = []
    for min_count, label, pattern_type in TIER_SPECS:
        items = sorted(
            [{"number": int(n), "overlap_count": int(c)} for n, c in counter.items() if c >= min_count],
            key=lambda x: (-x["overlap_count"], x["number"]),
        )
        if items:
            tiers.append(
                {
                    "min_count": min_count,
                    "label": label,
                    "pattern_type": pattern_type,
                    "number_count": len(items),
                    "items": items,
                }
            )

    tier_3 = next((t["items"] for t in tiers if t["min_count"] == 3), [])
    return {
        "summary": "용지 내 번호 겹침 빈도 (같은 칸 표시 횟수)",
        "all_frequent": all_frequent,
        "tiers": tiers,
        "triple_plus_overlap": {
            "pattern_label": "자동용지 3회이상 겹침",
            "items": tier_3,
        },
    }


def merge_frequency_patterns(primary: Dict[str, Any] | None, fallback: Dict[str, Any] | None) -> Dict[str, Any]:
    base = fallback or build_frequency_overlap_patterns({})
    if not primary or not primary.get("all_frequent"):
        return base

    merged_counts: Counter = Counter()
    for item in base.get("all_frequent") or []:
        try:
            n = int(item["number"])
            merged_counts[n] = max(merged_counts[n], int(item.get("overlap_count", 2)))
        except (TypeError, ValueError, KeyError):
            pass
    for item in primary.get("all_frequent") or []:
        try:
            n = int(item["number"])
            merged_counts[n] = max(merged_counts[n], int(item.get("overlap_count", 2)))
        except (TypeError, ValueError, KeyError):
            pass
    return build_frequency_overlap_patterns(merged_counts) if merged_counts else base


def accumulate_frequency_patterns(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    tier_video_votes: Dict[int, Counter] = {mc: Counter() for mc, _, _ in TIER_SPECS}
    tier_max_overlap: Dict[int, Dict[int, int]] = {mc: {} for mc, _, _ in TIER_SPECS}
    global_max: Dict[int, int] = {}
    global_video_votes: Counter = Counter()

    for entry in entries:
        fop = _get_fop_from_entry(entry)
        entry_counts: Dict[int, int] = {}
        for item in fop.get("all_frequent") or []:
            try:
                n = int(item["number"])
                c = int(item.get("overlap_count", 2))
                entry_counts[n] = max(entry_counts.get(n, 0), c)
            except (TypeError, ValueError, KeyError):
                pass

        if not entry_counts:
            continue

        for n, c in entry_counts.items():
            global_max[n] = max(global_max.get(n, 0), c)

        for min_count, _, _ in TIER_SPECS:
            for n, c in entry_counts.items():
                if c >= min_count:
                    tier_video_votes[min_count][n] += 1
                    tier_max_overlap[min_count][n] = max(tier_max_overlap[min_count].get(n, 0), c)

    # fix global_video_votes - recount properly
    global_video_votes = Counter()
    for entry in entries:
        fop = _get_fop_from_entry(entry)
        for item in fop.get("all_frequent") or []:
            try:
                global_video_votes[int(item["number"])] += 1
            except (TypeError, ValueError, KeyError):
                pass

    accumulated_tiers: List[Dict[str, Any]] = []
    for min_count, label, pattern_type in TIER_SPECS:
        votes = tier_video_votes[min_count]
        if not votes:
            continue
        accumulated_tiers.append(
            {
                "min_count": min_count,
                "label": label,
                "pattern_type": pattern_type,
                "number_count": len(votes),
                "items": sorted(
                    [
                        {
                            "number": n,
                            "video_votes": votes[n],
                            "max_overlap_count": tier_max_overlap[min_count].get(n, min_count),
                        }
                        for n in votes
                    ],
                    key=lambda x: (-x["video_votes"], -x["max_overlap_count"], x["number"]),
                ),
            }
        )

    all_frequent_acc = sorted(
        [
            {
                "number": n,
                "video_votes": global_video_votes[n],
                "max_overlap_count": global_max[n],
            }
            for n in global_max
            if global_max[n] >= 2
        ],
        key=lambda x: (-x["max_overlap_count"], -x["video_votes"], x["number"]),
    )

    tier_3 = next((t for t in accumulated_tiers if t["min_count"] == 3), None)
    return {
        "summary": "누적 용지 겹침 빈도 (칸 내 최대 겹침 + 패턴 용지 수)",
        "all_frequent": all_frequent_acc,
        "tiers": accumulated_tiers,
        "triple_plus_overlap": {
            "pattern_label": "자동용지 3회이상 겹침",
            "items": tier_3["items"] if tier_3 else [],
        },
    }
