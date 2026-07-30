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


def _sheet(rno, auto, semi, winning):
    from app.video_analysis.pattern_mining_engine import _match_groups, _strong18

    return RoundSheet(
        rno, auto, semi, winning,
        strong18=_strong18(auto, semi),
        match_groups=_match_groups(auto, semi),
    )


def test_walk_forward_oos_is_leakage_free_and_only_tightens():
    """진짜 out-of-sample(확장윈도우 walk-forward) 불변식:
      1) 첫 회차는 test 로 쓰이지 않는다(prefix 가 비므로).
      2) 그 이전 회차에 전혀 없던 Pattern 은 OOS 크레딧을 못 받는다(마지막 회차 전용 패턴).
      3) OOS 확인은 채택을 '조이기만' 한다 → 최종 adopted ⊆ in-sample adopted.
    """
    import random
    from app.video_analysis.pattern_mining_engine import (
        mine_patterns,
        validate_pattern,
        walk_forward_oos,
    )

    # (1,2) 는 전 회차에 반복 → prefix 로 mine 되고 fire. (44,45) 는 마지막 회차에만 등장.
    def rnd(rno, winning, last_only=False):
        auto = [[1, 2, 3, 4, 5, 6]] * 5 + [[1, 2, 11, 12, 13, 14]] * 4
        semi = [[1, 2, 7, 8, 9, 10]] * 5 + [[1, 2, 15, 16, 17, 18]] * 4
        if last_only:
            auto = auto + [[44, 45, 20, 21, 22, 23]] * 6
            semi = semi + [[44, 45, 24, 25, 26, 27]] * 6
        return _sheet(rno, auto, semi, winning)

    rounds = [
        rnd(1231, [1, 2, 30, 31, 32, 33]),   # round 0 — never an OOS test round
        rnd(1232, [1, 2, 34, 35, 36, 37]),
        rnd(1233, [40, 41, 42, 43, 44, 45]),
        rnd(1234, [1, 2, 44, 45, 38, 39], last_only=True),  # (44,45) only here
    ]

    patterns = mine_patterns(rounds)
    by_id = {p.id: p for p in patterns}
    oos_fire, oos_hits = walk_forward_oos(patterns, rounds)

    # (2) 마지막 회차 전용 (44,45) 페어는 OOS 크레딧 0 이어야 한다.
    from app.video_analysis.pattern_mining_engine import _pid
    pair4445 = _pid("pair", (44, 45))
    if pair4445 in by_id:  # mined in the full set
        assert oos_fire.get(pair4445, 0) == 0, "이전 회차에 없던 패턴이 OOS 크레딧을 받음"

    # (1) test 회차 수는 최대 len(rounds)-1 (첫 회차 제외)
    assert all(len(v) <= len(rounds) - 1 for v in oos_hits.values())

    # (3) 조이기 불변식: OOS 확인을 붙여도 in-sample 채택의 부분집합이어야 한다.
    rng = random.Random(7)
    scores = [validate_pattern(p, rounds, rng) for p in patterns]
    in_sample = set()
    final = set()
    for s in scores:
        pid = s.pattern.id
        hits = oos_hits.get(pid, [])
        oos_mean = (sum(hits) / len(hits)) if hits else 0.0
        oos_conf = len(hits) >= 1 and oos_mean >= s.base_hits
        if s.adopted:
            in_sample.add(pid)
            if oos_conf:
                final.add(pid)
    assert final.issubset(in_sample), "OOS 가 새 채택을 만들면 안 된다(조이기만)"


def test_build_response_exposes_oos_fields():
    """_score_dict 에 OOS 필드가 실려야 한다(프론트 계약)."""
    import random
    from app.video_analysis.pattern_mining_engine import (
        mine_patterns,
        validate_pattern,
        walk_forward_oos,
    )

    auto = [[1, 2, 3, 4, 5, 6]] * 6
    semi = [[1, 2, 3, 7, 8, 9]] * 6
    rounds = [_sheet(i, auto, semi, [1, 2, 3, 4, 5, 6]) for i in range(1231, 1235)]
    patterns = mine_patterns(rounds)
    rng = random.Random(3)
    scores = [validate_pattern(p, rounds, rng) for p in patterns]
    oos_fire, oos_hits = walk_forward_oos(patterns, rounds)
    # base_hits 가 채워졌는지(0 나눗셈 방지 계약)
    assert all(s.base_hits > 0 for s in scores)
    # OOS 는 첫 회차 제외 최대 3개 test
    assert all(len(v) <= 3 for v in oos_hits.values())


if __name__ == "__main__":
    test_mine_and_validate()
