"""엔진 감사 — 진단 분류·공통번호 검정·독립성·앙상블·개선 실험(승격 규칙)·누수 감지."""
from __future__ import annotations

import random

import pytest

from app.ingest import db
from app.ingest import engine_audit as A
from app.ingest import predictions as P


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    db.reset_for_tests()
    P.reset_for_tests()
    A.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()
    P.reset_for_tests()
    A.reset_for_tests()


def _seed_predictions(first=1000):
    P.backtest_stats(first=first)
    P.evaluate_pending()


def test_real_engines_are_indistinguishable_from_random(iso):
    _seed_predictions(1000)
    perf = A.performance_by_period()
    assert perf["methods"] and all(m["diagnosis"]["status"] in ("normal", "recent_drop_watch", "insufficient_data")
                                   for m in perf["methods"])
    for m in perf["methods"]:
        assert set(m["periods"]) == {"all", "last100", "last50", "last30", "last10"}


def test_consensus_and_independence(iso):
    _seed_predictions(1000)
    c = A.consensus()
    assert c["rounds_used"] > 200 and c["threshold_tests"]
    ind = c["independence"]
    assert 1 <= ind["effective_independent_engines"] <= ind["engines"]
    assert ind["pairs"][0]["jaccard"] >= ind["pairs"][-1]["jaccard"]
    assert len(c["number_selection"]) == 45


def test_duplicate_engine_detected_by_audit(iso):
    _seed_predictions(1200)
    # 'stats_hot' 을 그대로 복제한 가짜 엔진 → 이름만 다른 같은 알고리즘
    rows = db.query("SELECT draw_round, predicted_numbers FROM round_prediction_history WHERE prediction_method='stats_hot'")
    with db.transaction() as c:
        for r, nums in rows:
            P.save_prediction(c, rnd=r, method="stats_hotclone", ptype="backtest", numbers=db.loads(nums),
                              engine_version="t", training_range=f"1-{r - 1}")
    P.evaluate_pending()
    out = A.run_audit()
    assert any(a["type"] == "duplicate_engines" for a in out["alerts"])


def test_leak_detection(iso):
    with db.transaction() as c:
        P._ensure()
    with db.transaction() as c:
        P.save_prediction(c, rnd=1200, method="leaky", ptype="backtest", numbers=[1, 2, 3, 4, 5, 6],
                          engine_version="t", training_range="1-1200")  # 자기 회차 포함 = 누수
    assert A._leak_rows("leaky") == 1


def test_improvement_not_promoted_without_holdout_significance(iso):
    out = A.improvement_experiment()
    assert out["status"] in ("promoted", "rejected")
    v = A.versions()[0]
    assert v["selection_range"] and v["holdout_range"]
    sel_end = int(v["selection_range"].split("-")[1])
    assert int(v["holdout_range"].split("-")[0]) == sel_end + 1  # 선택·평가 기간 분리
    if out["status"] == "promoted":
        assert out["p_vs_random"] < out["alpha_bonferroni"] and out["p_vs_current"] < out["alpha_bonferroni"]


def test_ensemble_validation_runs_without_lookahead(iso):
    _seed_predictions(1100)
    e = A.ensemble_validation(warm=20)
    assert e["rounds"] > 100
    assert e["weighted_ensemble"]["rounds"] == e["rounds"]
    assert isinstance(e["promote"], bool)


def test_number_stats_and_detail(iso):
    _seed_predictions(1230)
    ns = A.number_stats()
    assert len(ns["numbers"]) == 45 and ns["theoretical_probability_per_draw"] == round(6 / 45, 4)
    d = A.number_detail(7)
    assert d["number"] == 7 and d["rounds_selected"] >= d["hits"]


def test_audit_api(iso):
    from fastapi.testclient import TestClient

    from app.main import app

    _seed_predictions(1200)
    c = TestClient(app)
    j = c.get("/api/v1/pipeline/audit/report").json()
    assert "answers" in j and "consensus_beats_random" in j["answers"]
    assert c.get("/api/v1/pipeline/audit/numbers").status_code == 200
    assert c.get("/api/v1/pipeline/audit/number/46").status_code == 400
