"""pattern_mining_engine smoke test (no store required for mine/validate unit)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.video_analysis.pattern_mining_engine import (  # noqa: E402
    RoundSheet,
    mine_patterns,
    validate_pattern,
    cluster_patterns,
    recommend_from_patterns,
)
import random  # noqa: E402


def test_mine_and_validate():
    auto = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], [1, 7, 13, 19, 25, 31], [1, 2, 7, 8, 20, 21]]
    semi = [[1, 2, 3, 14, 15, 16], [7, 8, 20, 21, 22, 23], [1, 7, 13, 19, 25, 31]]
    rounds = [
        RoundSheet(1, auto, semi, [1, 2, 7, 8, 9, 10], strong18=list(range(1, 19)), match_groups={}),
        RoundSheet(2, auto, semi, [3, 4, 5, 6, 11, 12], strong18=list(range(1, 19)), match_groups={}),
        RoundSheet(3, auto, semi, [1, 7, 13, 19, 25, 31], strong18=list(range(1, 19)), match_groups={}),
    ]
    # fill match groups
    from app.video_analysis.pattern_mining_engine import _match_groups, _strong18

    for r in rounds:
        r.match_groups = _match_groups(r.auto_lines, r.semi_lines)
        r.strong18 = _strong18(r.auto_lines, r.semi_lines)

    patterns = mine_patterns(rounds)
    assert len(patterns) > 0
    rng = random.Random(1)
    scores = [validate_pattern(p, rounds, rng) for p in patterns[:15]]
    assert all(hasattr(s, "adopted") for s in scores)
    clusters = cluster_patterns(scores)
    assert isinstance(clusters, list)
    adopted = [s for s in scores if s.adopted]
    rec = recommend_from_patterns(auto, semi, adopted, clusters, [])
    assert "ok" in rec
    print("patterns", len(patterns), "adopted", len(adopted), "rec_ok", rec["ok"])
    print("ok")


def test_auto_semi_core_excludes_fixed_semi():
    """반자동 고정수가 auto∩semi 코어 패턴에 재유입되면 안 된다(다른 엔진과 동일)."""
    from app.video_analysis.pattern_mining_engine import mine_patterns, _strong18, _match_groups

    # 고정수 후보: 45가 반자동 줄 ≥50% 에 반복(12줄 중 12)
    auto = [[1, 2, 3, 4, 5, 6]] * 12
    semi = [[1, 2, 3, 4, 5, 45]] * 12
    rounds = [
        RoundSheet(i, auto, semi, [1, 2, 3, 4, 5, 6], strong18=[], match_groups={})
        for i in range(1, 4)
    ]
    for r in rounds:
        r.match_groups = _match_groups(r.auto_lines, r.semi_lines)
        r.strong18 = _strong18(r.auto_lines, r.semi_lines)

    patterns = mine_patterns(rounds)
    cores = [p for p in patterns if p.kind == "auto_semi_core"]
    for p in cores:
        assert 45 not in p.numbers, f"고정수 45 가 코어에 포함됨: {p.numbers}"


if __name__ == "__main__":
    test_mine_and_validate()
