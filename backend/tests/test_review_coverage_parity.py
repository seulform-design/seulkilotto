"""복기 커버리지 ↔ 로컬 1:1 패리티 — 다회차 단일신호가 catchable 을 자르던 회귀 방지."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.review_verification import (
    COVERAGE_BUILD_ID,
    _best_of_engines_order,
    _coverage_hit_audit,
    _coverage_set_from_signals,
    _rank_signal,
    _review_expand_mode,
    _review_signal_key_for_round,
    _signals,
)


def _lines(*tickets: tuple[int, ...]) -> list[list[int]]:
    return [list(t) for t in tickets]


def _sample(round_no: int, winning: list[int], auto, semi) -> RoundSample:
    return RoundSample(
        round_no=round_no,
        auto_lines=auto,
        semi_lines=semi,
        winning=winning,
        features={n: {"support_rank": n} for n in range(1, 46)},
    )


def test_pair_product_promotes_both_side_numbers():
    """한쪽만 쓸린 번호보다 자동×반자동 동시 등장 번호가 pair_product 상위."""
    auto = _lines(
        (10, 11, 15, 16, 19, 21),
        (10, 11, 15, 30, 31, 32),
        (11, 15, 16, 33, 34, 35),
        (1, 2, 3, 40, 41, 42),  # auto-only popular noise
        (1, 2, 3, 40, 41, 42),
        (1, 2, 3, 40, 41, 42),
    )
    semi = _lines(
        (10, 11, 15, 16, 19, 21),
        (10, 11, 6, 7, 39, 43),
        (15, 16, 19, 6, 7, 45),
        (20, 22, 24, 26, 28, 29),  # semi-only noise
        (20, 22, 24, 26, 28, 29),
    )
    sigs = _signals(auto, semi)
    pair = _rank_signal(sigs["pair_product"], sigs["total_freq"], sigs["auto_freq"])
    # 양쪽 동시 등장 핵심이 top6에 들어와야 함(로컬 히어로와 같은 방향).
    assert 11 in pair[:6] or 15 in pair[:6]
    assert 10 in pair[:12]
    # auto-only 노이즈(1,2,3)는 pair_product 에서 뒤로 밀림.
    assert pair.index(1) > pair.index(11)


def test_review_expand_mode_upgrades_single_to_merge():
    assert _review_expand_mode("single_raw") == "merge_raw"
    assert _review_expand_mode("single_balanced") == "merge_raw"
    assert _review_expand_mode("boe_raw") == "boe_raw"
    assert _review_expand_mode("merge_balanced") == "merge_balanced"


def test_review_signal_key_uses_loo_not_global_multi():
    """held 회차용 키는 LOO — 전역 multi 와 달라도 된다."""
    # s1: support/pair 가 당첨을 잘 잡음
    s1 = _sample(
        2001,
        [10, 11, 15, 16, 19, 21],
        _lines((10, 11, 15, 16, 19, 21), (10, 11, 15, 1, 2, 3)),
        _lines((10, 11, 15, 16, 19, 21), (10, 11, 15, 4, 5, 6)),
    )
    # s2: combo/total 편향용 — 고번호만 양쪽
    s2 = _sample(
        2002,
        [30, 31, 32, 33, 34, 35],
        _lines((30, 31, 32, 33, 34, 35), (30, 31, 32, 1, 2, 3)),
        _lines((30, 31, 32, 33, 34, 35), (30, 31, 32, 4, 5, 6)),
    )
    # s3: 다시 teens 패턴
    s3 = _sample(
        2003,
        [6, 7, 11, 15, 39, 43],
        _lines((10, 11, 15, 16, 19, 21), (6, 7, 11, 15, 39, 43), (11, 15, 16, 19, 21, 6)),
        _lines((10, 11, 15, 16, 19, 21), (6, 7, 11, 15, 39, 43), (11, 15, 39, 43, 7, 6)),
    )
    samples = [s1, s2, s3]
    key, by = _review_signal_key_for_round(samples, 2003, multi_key="combo_strength")
    assert by == "loo_held"
    assert key != "auto_freq"
    # LOO 는 held=2003 을 빼고 s1·s2 로 고름 — combo_strength 강제 아님
    assert key in (
        "support",
        "pair_product",
        "total_freq",
        "semi_freq",
        "balanced",
        "combo_strength",
    )


def test_merge_raw_recovers_catchable_cut_by_wrong_single_signal():
    """잘못된 단일신호 top24 밖 catchable 을 merge(min-rank)가 회수."""
    # 당첨 일부는 support/pair 상위에만 있고 combo 순위는 밖.
    auto = _lines(
        *[(10, 11, 15, 16, 19, 21)] * 4,
        *[(30, 31, 32, 33, 34, 35)] * 8,  # combo/total 쪽 노이즈 풀
        (6, 7, 11, 15, 39, 43),
        (6, 7, 11, 12, 13, 14),
    )
    semi = _lines(
        *[(10, 11, 15, 16, 19, 21)] * 4,
        *[(20, 22, 24, 26, 28, 29)] * 3,
        (6, 7, 11, 15, 39, 43),
        (6, 7, 39, 43, 44, 45),
    )
    winning = [6, 7, 11, 15, 39, 43]
    sigs = _signals(auto, semi)
    ban = ["auto_freq"]
    # 의도적으로 combo_strength 단일 raw — 테ens/당첨 일부를 자를 수 있음
    bad = _coverage_set_from_signals(
        sigs,
        signal_key="combo_strength",
        selected_by="multi_round",
        exclude_keys=ban,
        expand_mode="single_raw",
        expand_size=24,
    )
    good = _coverage_set_from_signals(
        sigs,
        signal_key="pair_product",
        selected_by="loo_held",
        exclude_keys=ban,
        expand_mode=_review_expand_mode("single_raw"),
        expand_size=24,
    )
    assert good["expand18_mode"] == "precision_primary"
    assert COVERAGE_BUILD_ID == "expand24-v15-pool-first"
    audit_bad = _coverage_hit_audit(sigs, bad, winning, exclude_keys=ban)
    audit_good = _coverage_hit_audit(sigs, good, winning, exclude_keys=ban)
    # 다중엔진(pair+구간+min-rank) 경로가 단일 combo 경로보다 확장망 적중 ≥
    assert audit_good["expand18_count"] >= audit_bad["expand18_count"]
    # 용지 등장 당첨이 전엔진 min-rank top24 이면 multi expand 에 포함
    boe = _best_of_engines_order(sigs, exclude_keys=ban)
    present = {n for n in winning if sigs["total_freq"].get(n, 0) > 0}
    for n in present:
        if n in set(boe[:24]):
            assert n in set(good["expand18"])
