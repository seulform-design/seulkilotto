"""엔진 복구·정밀화 회귀 테스트 (2026-11-10).

데이터 / 엔진 / 수학 / 누수 / 회귀(API·review_verification·store·캐시) 를 실제 원본
CSV 를 독립 재계산한 값과 대조한다. 테스트는 원본을 읽기만 하며 어떤 데이터도 바꾸지 않는다.
"""
from __future__ import annotations

import csv
import random
from collections import Counter
from fractions import Fraction
from itertools import combinations
from math import comb

import pytest

from app.database import CSV_DATA_PATH, load_history
from app.stats_engine import cache as stats_cache
from app.stats_engine import probability as P
from app.stats_engine.backtest import (
    _walk_forward,
    build_full_history_backtest,
    build_ticket_backtest,
)
from app.stats_engine.draws import Draw, check_draw_sums, check_rows, draws_from_df, load_draws
from app.stats_engine.significance import coverage_significance
from app.stats_engine.windows import _consecutive_pmf, _hyper_pmf, build_window_stats


# ───────────────────────── 원본(독립 재계산 기준) ─────────────────────────

def _raw_rows():
    with open(CSV_DATA_PATH, encoding="utf-8", newline="") as fp:
        return list(csv.DictReader(fp))


def _raw_draws():
    rows = _raw_rows()
    out = []
    for r in rows:
        nums = sorted(int(r[f"num{i}"]) for i in range(1, 7))
        out.append((int(r["round"]), nums, int(r["bonus"])))
    out.sort()
    return out


RAW = _raw_draws()


# ───────────────────────────── 데이터 테스트 ─────────────────────────────

def test_no_missing_or_duplicate_rounds():
    rounds = [r for r, _, _ in RAW]
    assert len(rounds) == len(set(rounds)), "중복 회차"
    assert rounds == list(range(1, rounds[-1] + 1)), "누락 회차"


def test_number_range_uniqueness_and_bonus():
    for rnd, nums, bonus in RAW:
        assert len(nums) == 6 and len(set(nums)) == 6, rnd
        assert all(1 <= n <= 45 for n in nums), rnd
        assert 1 <= bonus <= 45 and bonus not in nums, rnd


def test_dates_monotonic_weekly():
    rows = sorted(_raw_rows(), key=lambda r: int(r["round"]))
    dates = [r["draw_date"] for r in rows]
    assert all(a < b for a, b in zip(dates, dates[1:]))


def test_loader_matches_raw_csv_exactly():
    draws = load_draws()
    assert [(d.round, list(d.numbers), d.bonus) for d in draws] == RAW


def test_integrity_checker_detects_injected_errors():
    rows = [
        {"round": 1, "draw_date": "2020-01-04", "num1": 1, "num2": 2, "num3": 3, "num4": 4, "num5": 5, "num6": 6, "bonus": 7},
        {"round": 1, "draw_date": "2020-01-11", "num1": 1, "num2": 2, "num3": 3, "num4": 4, "num5": 5, "num6": 6, "bonus": 7},
        {"round": 3, "draw_date": "2020-01-18", "num1": 1, "num2": 1, "num3": 3, "num4": 4, "num5": 5, "num6": 46, "bonus": 3},
        {"round": 4, "draw_date": "2020-01-01", "num1": 10, "num2": 20, "num3": 30, "num4": 40, "num5": 41, "num6": 42, "bonus": 10},
    ]
    rep = check_rows(rows)
    iss = rep["issues"]
    assert not rep["ok"]
    assert iss["duplicate_rounds"] == [1]
    assert iss["missing_rounds"] == [2]
    assert 3 in iss["out_of_range"] and 3 in iss["duplicate_numbers"]
    assert iss["bonus_in_main"] == [3, 4]  # 3회: 보너스 3 이 본번호에 포함


def test_aggregate_sums_match_round_count():
    s = check_draw_sums(load_draws())
    assert s["ok"] and s["main_total"] == 6 * len(RAW) and s["bonus_total"] == len(RAW)


# ───────────────────────────── 엔진(통계) 테스트 ─────────────────────────────

def test_frequency_matches_raw_all_and_recent():
    from app.analytics import calc_frequency

    df = load_history()
    for recent in (None, 10, 30, 50, 100):
        sub = RAW if recent is None else RAW[-recent:]
        expect = Counter(n for _, nums, _ in sub for n in nums)
        got = {it["number"]: it["count"] for it in calc_frequency(df, recent_n=recent)["items"]}
        assert got == {n: expect.get(n, 0) for n in range(1, 46)}, recent
        assert sum(got.values()) == 6 * len(sub)


def test_gap_matches_raw():
    from app.gap_utils import last_seen_gaps

    last = {}
    for i, (_, nums, _) in enumerate(RAW):
        for n in nums:
            last[n] = i
    n_draws = len(RAW)
    expect = {n: (n_draws if n not in last else n_draws - 1 - last[n]) for n in range(1, 46)}
    assert last_seen_gaps(load_history()) == expect


def test_window_stats_match_raw():
    out = build_window_stats()
    for w in out["windows"]:
        sub = RAW if w["window"] == "all" else RAW[-w["window"]:]
        cnt = Counter(n for _, nums, _ in sub for n in nums)
        bon = Counter(b for _, _, b in sub)
        for item in w["numbers"]:
            assert item["count"] == cnt.get(item["number"], 0)
            assert item["bonus_count"] == bon.get(item["number"], 0)  # 보너스는 분리 집계
        odd = Counter(sum(1 for n in nums if n % 2) for _, nums, _ in sub)
        assert w["tests"]["odd_even"]["observed"] == [odd.get(k, 0) for k in range(7)]
        low = Counter(sum(1 for n in nums if n <= 22) for _, nums, _ in sub)
        assert w["tests"]["low_high"]["observed"] == [low.get(k, 0) for k in range(7)]
        dec = [0] * 5
        for _, nums, _ in sub:
            for n in nums:
                dec[min(4, (n - 1) // 10)] += 1
        assert w["tests"]["decade"]["observed"] == dec
        cons = Counter(sum(1 for a, b in zip(nums, nums[1:]) if b - a == 1) for _, nums, _ in sub)
        assert w["tests"]["consecutive"]["observed"] == [cons.get(k, 0) for k in range(6)]
        assert w["sum"]["mean"] == round(sum(sum(n) for _, n, _ in sub) / len(sub), 2)


def test_co_occurrence_matrix_matches_raw():
    from app.co_occurrence import _build_matrix

    co, appear = _build_matrix(load_history())
    pc = Counter()
    for _, nums, _ in RAW:
        for a, b in combinations(nums, 2):
            pc[(a, b)] += 1
    for (a, b), c in pc.items():
        assert co[a][b] == c and co[b][a] == c
    assert int(co.sum()) == 2 * 15 * len(RAW)


def test_theoretical_pmfs_sum_to_one():
    assert abs(sum(_hyper_pmf(k, 23) for k in range(7)) - 1) < 1e-12
    assert abs(sum(_hyper_pmf(k, 22) for k in range(7)) - 1) < 1e-12
    assert abs(sum(_consecutive_pmf()) - 1) < 1e-12


# ───────────────────────────── 수학 테스트 ─────────────────────────────

def test_total_combinations_and_single_probability():
    assert comb(45, 6) == P.TOTAL_COMBINATIONS == 8_145_060
    assert P.jackpot_probability(1) == Fraction(1, 8_145_060)
    assert P.summary()["single_ticket_jackpot"] == "1/8,145,060"


def test_multiple_distinct_tickets_probability():
    assert P.jackpot_probability(5) == Fraction(5, 8_145_060)
    assert P.jackpot_probability(P.TOTAL_COMBINATIONS) == 1
    with pytest.raises(ValueError):
        P.jackpot_probability(P.TOTAL_COMBINATIONS + 1)


def test_duplicate_tickets_are_deduplicated():
    t = [[1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1], [7, 8, 9, 10, 11, 12], [1, 2, 3, 4, 5]]
    r = P.tickets_probability(t)
    assert r["distinct_tickets"] == 2 and r["duplicate_tickets_removed"] == 1
    assert len(r["invalid_tickets"]) == 1
    assert r["jackpot_probability"] == "2/8,145,060" and r["kind"] == "mathematical"


def test_match_pmf_and_prize_probabilities_exact():
    pmf = P.match_pmf()
    assert sum(pmf) == 1
    assert sum(k * pmf[k] for k in range(7)) == Fraction(4, 5)  # 기대 일치 0.8
    pr = P.prize_probabilities()
    assert pr["1"] * P.TOTAL_COMBINATIONS == 1
    assert pr["2"] * P.TOTAL_COMBINATIONS == 6
    assert pr["3"] * P.TOTAL_COMBINATIONS == 228
    assert pr["4"] * P.TOTAL_COMBINATIONS == 11_115
    assert pr["5"] * P.TOTAL_COMBINATIONS == 182_780
    assert pr["2"] + pr["3"] == pmf[5]


def test_match_count_and_prize_rank():
    w, b = [3, 11, 19, 27, 35, 43], 8
    assert P.match_count([3, 11, 19, 27, 35, 43], w) == 6 and P.prize_rank(w, w, b) == 1
    assert P.prize_rank([3, 11, 19, 27, 35, 8], w, b) == 2
    assert P.prize_rank([3, 11, 19, 27, 35, 9], w, b) == 3
    assert P.prize_rank([3, 11, 19, 27, 1, 2], w, b) == 4
    assert P.prize_rank([3, 11, 19, 1, 2, 8], w, b) == 5  # 보너스는 일치 수에 더하지 않는다
    assert P.prize_rank([1, 2, 4, 5, 6, 8], w, b) is None
    for bad in ([1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 46], [1, 1, 2, 3, 4, 5]):
        with pytest.raises(ValueError):
            P.validate_ticket(bad)


# ───────────────────────────── 누수(미래 참조) 테스트 ─────────────────────────────

def _perturb_future(draws, cut_idx, seed=7):
    rng = random.Random(seed)
    out = list(draws[:cut_idx])
    for d in draws[cut_idx:]:
        nums = tuple(sorted(rng.sample(range(1, 46), 6)))
        bonus = rng.choice([n for n in range(1, 46) if n not in nums])
        out.append(Draw(d.round, d.draw_date, nums, bonus))
    return out


def test_full_history_walk_forward_has_no_lookahead():
    """회차 R 이후 데이터를 통째로 바꿔도 R 까지의 채점은 한 글자도 변하지 않아야 한다."""
    draws = load_draws()
    cut = 700
    a, ra = _walk_forward(draws, [6, 18], 50)
    b, rb = _walk_forward(_perturb_future(draws, cut), [6, 18], 50)
    n_before = cut - 50  # 채점 인덱스 0.. 은 draws[50..]
    assert ra[:n_before] == rb[:n_before]
    for s in a:
        for k in (6, 18):
            # 회차 cut 은 자신이 바뀌었으니(채점 대상) 그 이전까지만 동일해야 한다
            assert a[s][k][:n_before] == b[s][k][:n_before], (s, k)


def test_signal_accuracy_respects_before_round():
    from app.prediction_signals import backtest_signal_accuracy

    df = load_history()
    acc = backtest_signal_accuracy(df, int(df["round"].max()), rounds=3, before_round=300)
    assert acc["tested_rounds"] and max(acc["tested_rounds"]) < 300
    for src in acc["by_source"].values():
        assert all(p["round"] < 300 for p in src["per_round"])


# ───────────────────────────── 백테스트 테스트 ─────────────────────────────

def test_new_backtest_equals_original_implementation():
    """독립 엔진(stats_engine)이 원래 구현(video_analysis.full_history_backtest)과 같은 수치를 낸다."""
    from app.video_analysis.full_history_backtest import build_full_history_backtest as original

    old = original()
    new = build_full_history_backtest()
    assert old["tested_rounds"] == new["tested_rounds"] and old["total_rounds"] == new["total_rounds"]
    o = {r["strategy"]: r["by_k"] for r in old["strategies"]}
    n = {r["strategy"]: r["by_k"] for r in new["strategies"]}
    assert o.keys() == n.keys()
    for s in o:
        for k in o[s]:
            for f in ("hits", "mean_per_round", "lift", "p_value", "significant", "significant_raw"):
                assert o[s][k][f] == n[s][k][f], (s, k, f)
    assert old["any_beats_random"] == new["any_beats_random"]


def test_significance_helper_equals_original():
    from app.video_analysis.review_verification import _coverage_significance as orig

    for hits, rounds, k in [(0, 10, 6), (8, 10, 6), (500, 1000, 6), (2400, 1000, 18), (3, 3, 10), (5, 0, 6), (5, 5, 45)]:
        assert coverage_significance(hits, rounds, k) == orig(hits, rounds, k)


def test_ticket_backtest_counts_are_consistent():
    r = build_ticket_backtest(reps=20)
    assert r["ok"] and r["kind"] == "backtest"
    n = r["tested_rounds"]
    assert r["theoretical"]["expected_mean_matches"] == 0.8
    for s in r["strategies"]:
        mc = s["match_counts"]
        assert sum(mc[str(k)] for k in range(7)) == n
        assert mc["prize_2"] + mc["prize_3"] == mc["5"]
        assert sum(int(v) for v in s["number_hit_frequency"].values()) == sum(k * mc[str(k)] for k in range(7))
        assert sum(p["rounds"] for p in s["periods"]) == n
    rb = r["random_baseline"]
    assert rb["tickets"] == n * 20 and 0.7 < rb["mean_matches"] < 0.9


# ───────────────────────────── 추천 유효성 ─────────────────────────────

def _assert_valid_sets(sets):
    seen = set()
    for nums in sets:
        assert len(nums) == 6 and len(set(nums)) == 6 and all(1 <= n <= 45 for n in nums), nums
        t = tuple(sorted(nums))
        assert t not in seen, f"중복 조합 {t}"
        seen.add(t)


def test_weighted_and_smart_generators_valid():
    from app.analytics import generate_smart_sets, generate_weighted_sets

    df = load_history()
    for seed in (1, 2, 3):
        _assert_valid_sets([s["numbers"] for s in generate_weighted_sets(df, n_sets=10, seed=seed)["combinations"]])
        _assert_valid_sets([s["numbers"] for s in generate_smart_sets(df, n_sets=5, seed=seed)["combinations"]])


def test_ensemble_generator_valid_and_probability_separated(monkeypatch):
    """무거운 신호 계산은 고정 스텁으로 대체 — 조합 생성·필터·확률 표기 계약만 검증."""
    import app.prediction_signals as ps
    from app.analytics import generate_ensemble_sets

    ranked = [{"number": n, "sources": (["machine-reversion"] if n % 3 == 0 else ["classic-blend"] if n % 3 == 1 else ["decade-gap"])}
              for n in range(1, 46)]
    monkeypatch.setattr(ps, "build_prediction_signals", lambda **kw: {"target_round": 9999, "ranked_numbers": ranked, "strong_details": []})
    monkeypatch.setattr(ps, "backtest_signal_accuracy", lambda *a, **kw: {"available": False, "by_source": {}})
    out = generate_ensemble_sets(load_history(), n_sets=10, seed=5)
    sets = [c["numbers"] for c in out["combinations"]]
    assert len(sets) == 10
    _assert_valid_sets(sets)
    assert out["probability"]["kind"] == "mathematical"
    assert out["probability"]["jackpot_probability"] == "10/8,145,060"
    for c in out["combinations"]:
        assert c["jackpot_probability"] == "1/8,145,060"
        assert 0 <= c["coselection"]["avoidance_score"] <= 100  # 회피 점수는 별도 필드


# ───────────────────────────── 캐시 ─────────────────────────────

def test_signature_cache_invalidates_on_data_change():
    stats_cache.clear()
    calls = []

    def builder():
        calls.append(1)
        return {"v": len(calls)}

    a = stats_cache.cached("t", "sigA", (1,), builder)
    b = stats_cache.cached("t", "sigA", (1,), builder)
    c = stats_cache.cached("t", "sigB", (1,), builder)  # 데이터 변경 → 재계산
    assert a == b == {"v": 1} and c == {"v": 2} and len(calls) == 2
    stats_cache.clear()


def test_signature_changes_when_past_round_corrected():
    from app.stats_engine.draws import data_signature

    draws = load_draws()
    fixed = list(draws)
    d = fixed[10]
    fixed[10] = Draw(d.round, d.draw_date, d.numbers, next(n for n in range(1, 46) if n not in d.numbers and n != d.bonus))
    assert data_signature(draws) != data_signature(fixed)


# ───────────────────────────── API 회귀 ─────────────────────────────

@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.mark.parametrize("path", [
    "/api/v1/stats/frequency",
    "/api/v1/stats/frequency?recent_n=10",
    "/api/v1/stats/temperature",
    "/api/v1/stats/co-occurrence",
    "/api/v1/stats/full-history-backtest",
    "/api/v1/stats/ticket-backtest?reps=20",
    "/api/v1/stats/windows",
    "/api/v1/stats/integrity",
    "/api/v1/stats/probability?n=5",
    "/api/v1/photo-analysis/full-history-backtest",
    "/api/v1/photo-analysis/storage-status",
    "/api/v1/history/latest",
    "/api/v1/meta",
])
def test_api_endpoints_ok(client, path):
    r = client.get(path)
    assert r.status_code == 200, (path, r.text[:300])


def test_api_probability_tickets(client):
    r = client.post("/api/v1/stats/probability/tickets", json={"tickets": [[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], [10, 20, 30, 40, 41, 42]]})
    assert r.status_code == 200
    j = r.json()
    assert j["distinct_tickets"] == 2 and j["jackpot_probability"] == "2/8,145,060"


def test_api_integrity_is_clean(client):
    j = client.get("/api/v1/stats/integrity").json()
    assert j["ok"] and j["loaded_missing_rounds"] == [] and j["sums"]["ok"]


def test_photo_router_endpoints_restored(client):
    paths = {r.path for r in client.app.routes}
    for p in ("/api/v1/photo-analysis/round-learning", "/api/v1/photo-analysis/feature-learning",
              "/api/v1/photo-analysis/pattern-mining", "/api/v1/photo-analysis/nested-cv",
              "/api/v1/photo-analysis/graft-coverage", "/api/v1/photo-analysis/review-verification",
              "/api/v1/photo-analysis/carryover-learning", "/api/v1/photo-analysis/accumulated"):
        assert p in paths, p


def test_store_module_and_review_verification_importable():
    from app.video_analysis import review_verification, store

    assert callable(store.store_signature) and isinstance(store.store_signature(), str)
    assert callable(review_verification.build_review_verification)
