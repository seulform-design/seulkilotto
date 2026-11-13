"""통합 마스터 엔진 V8~V12 — 누수 재계산·신뢰도 기간·무작위 시뮬레이션·후보 생성·불변 저장."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.ingest import db
from app.ingest import engine_audit as A
from app.ingest import master_engine as M
from app.ingest import predictions as P
from app.ingest import reverse_analysis as R


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    for m in (db, P, A, R):
        m.reset_for_tests()
    yield tmp_path
    for m in (db, P, A, R):
        m.reset_for_tests()


def _seed(first=1100):
    P.backtest_stats(first=first)
    P.evaluate_pending()


def test_v8_replay_matches_and_detects_tampering(iso):
    _seed(1150)
    assert M.v8_leakage(sample=30)["replay_check"]["mismatched"] == 0
    with db.transaction() as c:  # 저장 번호를 미래 결과로 바꿔치기한 행 → 재계산 불일치로 잡혀야 함
        c.execute("UPDATE round_prediction_history SET predicted_numbers = ? WHERE prediction_method = 'stats_hot' "
                  "AND prediction_type = 'backtest'", (db.dumps([1, 2, 3, 4, 5, 6]),))
    out = M.v8_leakage(sample=200)
    assert out["replay_check"]["mismatched"] > 0 and out["status"] == "issues_found"


def test_v9_v10_v11(iso):
    _seed(1100)
    v9 = M.v9_reliability()
    m = next(x for x in v9["methods"] if x["method"] == "stats_hot")
    assert set(m["periods"]) == {"last20", "last50", "last100", "all"} and m["periods"]["last20"]["rounds"] == 20
    assert m["grade"]
    v10 = M.v10_number_bias()
    assert len(v10["numbers"]) == 45 and "random_baseline" not in str(v10["recommendation_correlation_top"])
    v11 = M.v11_random_sim(sims=500)
    rb = next(x for x in v11["methods"] if x["method"] == "random_baseline")
    assert 0.0 <= rb["percentile_vs_random"] <= 1.0


def test_number_scores_and_combos_use_only_prior_data():
    from app.stats_engine.draws import load_draws

    draws = load_draws()
    sc = M.number_scores(draws[:-1], {7: 3, 8: 1}, {7: 3.0})
    assert len(sc) == 45 and [r["tier"] for r in sc].count("A") == 10 and [r["tier"] for r in sc].count("C") == 10
    combos = M.generate_combos(sc, seed=1)
    assert len(combos) == 10
    assert [c["group"] for c in combos] == ["core"] * 3 + ["dispersion"] * 4 + ["experimental"] * 3
    for c in combos:
        assert len(set(c["numbers"])) == 6 and c["structure"]["pass_rate"] >= 6 / 7
    for i, a in enumerate(combos):
        for b in combos[i + 1:]:
            assert len(set(a["numbers"]) & set(b["numbers"])) <= 4
    assert M.number_scores(draws[:-1], {7: 3, 8: 1}, {7: 3.0}) == sc  # 결정적


def test_v12_current_saves_once_and_is_immutable(iso, monkeypatch):
    _seed(1200)
    from app.stats_engine.draws import load_draws

    target = load_draws()[-1].round + 1
    monkeypatch.setattr(P, "draw_cutoff", lambda r: datetime(2999, 1, 1, tzinfo=timezone.utc))
    out = M.v12_current()
    assert out["target_round"] == target and out["saved_live_predictions"] == 10
    first = [c["numbers"] for c in out["combos"]]
    again = M.v12_current()
    assert again["saved_live_predictions"] == 0 and [c["numbers"] for c in again["combos"]] == first
    assert again["combos_frozen_at"]
    monkeypatch.setattr(P, "draw_cutoff", lambda r: datetime(2000, 1, 1, tzinfo=timezone.utc))
    late = M.v12_current()
    assert late["save_note"] and late["saved_live_predictions"] == 0


def test_master_api(iso):
    from fastapi.testclient import TestClient

    from app.main import app

    j = TestClient(app).get("/api/v1/pipeline/master/report").json()
    assert "diagnosis" in j and "probability" in j


def test_v12_backtest_stored_for_past_rounds_and_round_audit(iso):
    from app.ingest import round_audit as RA

    RA.reset_for_tests()
    _seed(1180)
    rep = M.v12_walk_forward(rounds=15)
    assert rep["stored_backtest_predictions"] == 150  # 15회차 × 10조합 — 이번 회차만이 아니라 과거 회차에도 후보군 존재
    rows = db.query("SELECT draw_round, COUNT(*), MAX(training_data_range) FROM round_prediction_history "
                    "WHERE prediction_method = 'v12_integrated' AND prediction_type = 'backtest' GROUP BY draw_round")
    for rnd, cnt, rng in rows:
        assert cnt == 10 and int(rng.split("-")[1]) < int(rnd)  # 학습 범위는 대상 회차 이전
    assert M.v12_walk_forward(rounds=15)["stored_backtest_predictions"] == 0  # 재실행해도 기록 불변(중복 저장 없음)
    P.evaluate_pending()
    a = RA.audit(min_rounds=10)
    v12 = next(x for x in a["methods"] if x["method"] == "v12_integrated" and x["type"] == "backtest")
    assert v12["combos_per_round"] == 10 and v12["games"] == 150 and v12["rounds"] == 15
    assert v12["verdict"] in ("random_equivalent", "below_trend", "below_random", "above_random")
    assert "random_baseline" not in {x["method"] for x in a["methods"]}
    t = RA.round_table(limit=10)
    assert len(t["rounds"]) == 10 and any(c["method"] == "v12_integrated" for c in t["columns"])


def test_round_audit_flags_and_releases_below_random(iso, monkeypatch):
    from app.ingest import round_audit as RA

    RA.reset_for_tests()
    _seed(1150)
    from app.stats_engine.draws import load_draws

    with db.transaction() as c:  # 일부러 당첨번호를 피한 엔진 — 전 회차 일치 0 → 하락 판정 → 투표 제외
        for d in load_draws()[-80:]:
            pick = [x for x in range(1, 46) if x not in d.numbers][:6]
            P.save_prediction(c, rnd=d.round, method="engine_bad", ptype="backtest", numbers=pick, engine_version="t")
    P.evaluate_pending()
    a = RA.audit()
    bad = next(x for x in a["methods"] if x["method"] == "engine_bad")
    assert bad["verdict"] == "below_random" and "engine_bad" in a["actions"]["excluded_now"]
    assert "engine_bad" in RA.excluded_methods()
    with db.transaction() as c:
        c.execute("DELETE FROM round_prediction_evaluation WHERE prediction_id IN (SELECT prediction_id FROM "
                  "round_prediction_history WHERE prediction_method = 'engine_bad')")
        c.execute("DELETE FROM round_prediction_history WHERE prediction_method = 'engine_bad'")
    a2 = RA.audit()
    assert "engine_bad" in a2["actions"]["released"] and "engine_bad" not in RA.excluded_methods()


def test_miss_analysis_uses_prior_data_and_requires_two_period_replication(iso):
    from app.ingest import round_audit as RA

    RA.reset_for_tests()
    _seed(1180)
    M.v12_walk_forward(rounds=20)
    P.evaluate_pending()
    rep = RA.miss_analysis(window=20)
    assert rep["rounds"] == 20 and rep["coverage"]["candidate_pool_mean"] > 6
    assert len(rep["patterns"]) == len(RA.FEATURES) and rep["why_missed"]
    for p in rep["patterns"]:  # 채택은 두 기간 모두 보정 후 유의할 때만
        if p["adopted"]:
            assert all(h["p"] < rep["alpha_bonferroni"] for h in p["halves"])
    assert len(rep["recent_examples"]) == 12
    from app.stats_engine.draws import load_draws

    d = load_draws()
    f = RA._number_features(d[:100], d[99].numbers[0])
    assert f["carry"] and f["gap"] == 0  # 직전 회차 번호 → 이월, 미출 0


def test_calibrate_tiers_matches_gap_base_rates():
    from collections import Counter

    from app.stats_engine.draws import load_draws

    draws = load_draws()
    # 오래 안 나온 번호에 투표가 몰린 상황을 만들어도 A/B/C 의 미출 구간 구성은 기준 비율을 따른다
    sc0 = M.number_scores(draws[:-1], {}, {})
    longs = [r["number"] for r in sc0 if M.gap_bucket(r["gap"]) == "long"]
    sc = M.number_scores(draws[:-1], {n: 9 for n in longs}, {n: 9.0 for n in longs})
    cal = M.calibrate_tiers(sc)
    base = Counter(M.gap_bucket(r["gap"]) for r in cal)
    got = Counter(r["gap_bucket"] for r in cal if r["tier"] in ("A", "B", "C"))
    for b, n in base.items():
        assert abs(got[b] - 30 * n / 45) <= 1.5
    assert [r["tier"] for r in cal].count("A") == 10
    combos = M.generate_combos(sc, seed=7)
    assert len(combos) == 10
