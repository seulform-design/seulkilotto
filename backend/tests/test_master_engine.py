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
