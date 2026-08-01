"""expand walk-forward · 다중엔진 top24 방출(크기 고정)."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.review_verification import (
    COVERAGE_BUILD_ID,
    DEFAULT_EXPAND_SIZE,
    _coverage_hit_audit,
    _coverage_set_from_signals,
    _decade_tier_sets,
    _multi_engine_order,
    _signals,
    _walkforward_expand_policy,
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


def test_walkforward_picks_expand_mode_and_coverage_emits_24():
    s1 = _sample(
        1001,
        [1, 2, 3, 4, 5, 6],
        _lines((1, 2, 3, 7, 8, 9), (1, 2, 4, 10, 11, 12), (3, 5, 6, 13, 14, 15)),
        _lines((1, 2, 3, 16, 17, 18), (4, 5, 6, 19, 20, 21), (7, 8, 9, 22, 23, 24)),
    )
    s2 = _sample(
        1002,
        [7, 8, 9, 10, 11, 12],
        _lines((7, 8, 9, 1, 2, 3), (7, 10, 11, 4, 5, 6), (8, 9, 12, 13, 14, 15)),
        _lines((7, 8, 9, 16, 17, 18), (10, 11, 12, 19, 20, 21), (1, 2, 3, 22, 23, 24)),
    )
    s3 = _sample(
        1003,
        [13, 14, 15, 16, 17, 18],
        _lines((13, 14, 15, 1, 2, 3), (13, 16, 17, 4, 5, 6), (14, 15, 18, 7, 8, 9)),
        _lines((13, 14, 15, 19, 20, 21), (16, 17, 18, 22, 23, 24), (10, 11, 12, 25, 26, 27)),
    )
    samples = [s1, s2, s3]
    ban = ["auto_freq"]
    wf = _walkforward_expand_policy(samples, exclude_keys=ban)
    assert wf["ok"] is True
    assert wf["selected_size"] in (18, 24, 30)

    sigs = _signals(s1.auto_lines, s1.semi_lines)
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="multi_round",
        exclude_keys=ban,
        expand_mode=wf["selected_mode"],
        expand_size=30,  # WF가 30이어도 방출은 24
    )
    assert set(cov["core6"]).issubset(set(cov["expand18"]))
    assert len(cov["expand18"]) == DEFAULT_EXPAND_SIZE == 24
    assert cov["expand_size"] == 24
    assert cov["coverage_build"] == COVERAGE_BUILD_ID == "expand24-v8-loo-rescue"
    assert cov["expand18_mode"] == "loo_reverse_rescue"
    assert "reverse_graft" in cov
    assert len(cov.get("share_opt") or []) == 6
    assert cov["expand_size"] in (24, 30)
    assert "multi_engine" in cov

    audit = _coverage_hit_audit(sigs, cov, s1.winning, exclude_keys=ban)
    assert audit["catchable_count"] + len(audit["uncatchable"]) == 6


def test_walkforward_fallback_when_too_few_samples():
    wf = _walkforward_expand_policy([], exclude_keys=["auto_freq"])
    assert wf["ok"] is False
    assert wf["selected_size"] == DEFAULT_EXPAND_SIZE


def test_decade_expected_promoted_into_expand24():
    """구간 기대수에 있는 번호는 주신호 순위가 밀려도 다중엔진 확장에 들어갈 수 있다."""
    # 단번대: 1,2,3 강수 / 4,5,7 기대 후보가 되도록 빈도 배치
    auto = _lines(
        *[(1, 2, 3, 10, 20, 30)] * 8,
        *[(4, 5, 7, 11, 21, 31)] * 3,
        (12, 22, 32, 40, 41, 42),
    )
    semi = _lines(
        *[(1, 2, 3, 13, 23, 33)] * 8,
        *[(4, 5, 7, 14, 24, 34)] * 3,
        (15, 25, 35, 40, 41, 43),
    )
    sigs = _signals(auto, semi)
    strong, expected = _decade_tier_sets(sigs)
    assert 7 in strong or 7 in expected
    order, meta = _multi_engine_order(sigs, "support", exclude_keys=["auto_freq"])
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="t",
        exclude_keys=["auto_freq"],
        expand_mode="single_raw",
        expand_size=18,
    )
    assert 7 in cov["expand18"] or 7 in meta["decade_strong"] or 7 in meta["decade_expected"]
    # 다중엔진 상위 24 안에 기대/강수 단번대가 포함
    top24 = set(order[:24])
    assert (strong | expected) & top24


def test_default_expand_is_24():
    assert DEFAULT_EXPAND_SIZE == 24


def test_loo_rescue_pulls_mid_tier_winners_into_expand():
    """빽빽한 용지에서 중하위 당첨(6·7)이 합의에 밀려도 역산구조로 확장망에 들어온다."""
    from app.video_analysis.review_verification import (
        _apply_expand_rescue,
        _baseline_expand_from_order,
        _loo_expand_rescue_policy,
    )

    # 고빈도 노이즈로 present>24 · 당첨 6·7은 저빈도 양쪽 등장
    noise_a = [
        (10 + i % 5, 20 + i % 5, 30 + i % 5, 12, 22, 32)
        for i in range(12)
    ]
    noise_s = [
        (11 + i % 5, 21 + i % 5, 31 + i % 5, 14, 24, 34)
        for i in range(12)
    ]
    auto = _lines(
        *noise_a,
        *[(5, 9, 13, 16, 23, 27)] * 4,
        *[(16, 23, 27, 31, 32, 34)] * 3,
        (6, 11, 15, 39, 16, 23),
        (7, 11, 15, 43, 27, 31),
        (6, 7, 11, 15, 39, 43),
    )
    semi = _lines(
        *noise_s,
        *[(5, 9, 13, 16, 23, 27)] * 4,
        *[(16, 23, 27, 31, 32, 34)] * 3,
        (6, 11, 15, 39, 16, 23),
        (7, 11, 15, 43, 27, 31),
        (6, 7, 11, 15, 39, 43),
    )
    win = [6, 7, 11, 15, 39, 43]
    s1 = _sample(1201, win, auto, semi)
    s2 = _sample(
        1202,
        [5, 9, 16, 23, 27, 31],
        _lines(*[(5, 9, 16, 23, 27, 31)] * 5, (10, 11, 12, 20, 21, 22)),
        _lines(*[(5, 9, 16, 23, 27, 31)] * 5, (13, 14, 15, 24, 25, 26)),
    )
    s3 = _sample(
        1203,
        [10, 14, 20, 24, 30, 34],
        _lines(*[(10, 14, 20, 24, 30, 34)] * 5, (1, 2, 3, 4, 5, 6)),
        _lines(*[(10, 14, 20, 24, 30, 34)] * 5, (7, 8, 9, 11, 12, 13)),
    )
    samples = [s1, s2, s3]
    ban = ["auto_freq"]
    pol = _loo_expand_rescue_policy(samples, exclude_keys=ban, held_round=1201)
    assert pol["ok"] is True
    assert pol["selected"] in ("baseline24", "rescue24", "rescue30")

    sigs = _signals(auto, semi)
    present = {n for n in range(1, 46) if sigs["total_freq"].get(n, 0) > 0}
    assert len(present) >= 20
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="pair_product",
        selected_by="loo_held",
        exclude_keys=ban,
        auto_lines=auto,
        semi_lines=semi,
        samples=samples,
        held_round=1201,
    )
    order, meta = _multi_engine_order(
        sigs, "pair_product", exclude_keys=ban, auto_lines=auto, semi_lines=semi
    )
    base = _baseline_expand_from_order(order, cov["core6"], present, 24)
    rescued, rmeta = _apply_expand_rescue(
        base, order, meta, present, cov["core6"], size=cov["expand_size"], sigs=sigs
    )
    # 구출 후 용지 등장 당첨은 baseline 이상
    assert len(set(win) & set(rescued)) >= len(set(win) & set(base))
    # 커버리지 방출도 6·7 중 최소 하나 이상(또는 이미 baseline에 있으면 유지)
    assert len(set(win) & set(cov["expand18"])) >= 4
    assert cov["expand_size"] in (24, 30)
    assert "rescue" in (cov.get("reverse_graft") or {})
