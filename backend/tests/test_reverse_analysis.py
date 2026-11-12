"""V5 역분석 · V6 자동 보정 · V7 자기개선 — 격리·누수 방지·승격 규칙·원본 보존."""
from __future__ import annotations

import pytest

from app.ingest import db
from app.ingest import engine_audit as A
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


def _seed(first=1000):
    P.backtest_stats(first=first)
    P.evaluate_pending()


def test_features_and_reference():
    f = R.features_of([1, 2, 3, 20, 33, 45], prev=[3, 4, 5, 6, 7, 8])
    assert f["odd"] == 4 and f["low"] == 4 and f["sum"] == 104 and f["consec"] == 2 and f["overlap_prev"] == 1
    assert f["max_decade"] == 3
    ref = R.reference()
    assert abs(ref["mean"]["odd"] - 6 * 23 / 45) < 0.05  # 홀수 23개 → 기대 3.07
    assert abs(ref["consec_any"] - (1 - 3838380 / 8145060)) < 0.02  # 연속쌍 1개 이상 정확값 0.529


def test_v5_reverse_analysis_reports_chance_without_inventing_rules(iso):
    _seed(800)
    rep = R.reverse_analysis(min_rounds=90)
    assert rep["methods"]
    for m in rep["methods"]:
        assert m["heterogeneity"]["blocks"] >= 3
        assert all(b["n"] == R.BLOCK for b in m["high_blocks"] + m["low_blocks"])
        assert m["causes"]
    assert len(rep["feature_vs_matches"]) == len(R.FEATURES)
    assert R.last_report("v5")["latest_round"] == rep["latest_round"]


def test_quarantine_marks_but_keeps_rows(iso):
    _seed(1200)
    with db.transaction() as c:
        P.save_prediction(c, rnd=1210, method="leaky", ptype="backtest", numbers=[1, 2, 3, 4, 5, 6],
                          engine_version="t", training_range="1-1210")
    P.evaluate_pending()
    before = db.query("SELECT COUNT(*) FROM round_prediction_history")[0][0]
    inv = R.inventory()
    assert inv["quarantine"]["by_reason"].get("future_data_in_training") == 1
    assert db.query("SELECT COUNT(*) FROM round_prediction_history")[0][0] == before  # 삭제 없음
    assert 1210 not in R._load("backtest").get("leaky", {})  # 집계에서만 제외


def test_v6_candidates_are_leak_free_and_never_overwrite_base(iso):
    from app.stats_engine.draws import load_draws

    draws = load_draws()
    # 후보 생성 함수는 대상 회차 이전 데이터만 본다: 미래 회차를 바꿔도 결과가 같아야 함
    k = 600
    for name in ("feature:hot_window30", "spread:cold", "cond:overdue", "blend:borda_equal", "pattern:hot_avoid_prev"):
        a = R.candidate_pick(name, draws[:k])
        assert len(a) == 6 and len(set(a)) == 6 and all(1 <= n <= 45 for n in a)
        assert a == R.candidate_pick(name, draws[:k])
    out = R.auto_correction()
    assert out["status"] in ("promoted", "rejected") and out["combos_per_round"] == 1
    sel_end = int(out["selection_range"].split("-")[1])
    assert int(out["holdout_range"].split("-")[0]) == sel_end + 1
    if out["status"] == "rejected":
        assert R.approved_models() == []
    else:
        assert out["p_vs_random"] < out["alpha_bonferroni"] and out["p_vs_base"] < out["alpha_bonferroni"]
    # 원본 전략(stats_*)의 저장 예측은 V6 실행으로 바뀌지 않는다
    assert db.query("SELECT COUNT(*) FROM round_prediction_history WHERE prediction_method LIKE 'v6_%'")[0][0] == 0


def test_v7_loop_records_and_skips_same_round(iso):
    _seed(1100)
    out = R.self_optimize()
    assert out["kind"] == "v7" and len(out["steps"]) == 5 and out["decision"]
    assert R.self_optimize()["status"] == "skipped_same_round"
    rep = R.full_report()
    assert rep["v5"] and rep["v6"] and rep["v7"] and rep["probability"]["mathematical"]["first_prize"] == "1/8,145,060"


def test_approved_model_is_added_to_live_not_replacing(iso):
    from datetime import datetime, timezone

    from app.stats_engine.draws import load_draws

    R._ensure()
    with db.transaction() as c:
        c.execute("INSERT INTO engine_versions (version_id,engine,params_json,status,selection_range,holdout_range,metrics_json,"
                  "reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  ("v6test0001", "v6:spread:hot", db.dumps({"candidate": "spread:hot", "base": "stats_hot"}), "promoted",
                   "1-10", "11-20", db.dumps({}), "test", db.now_iso()))
    nxt = load_draws()[-1].round + 1
    out = P.create_live(nxt, include_ensemble=False, now=datetime(2000, 1, 1, tzinfo=timezone.utc))
    assert out["status"] == "ok"
    methods = {r[0] for r in db.query("SELECT prediction_method FROM round_prediction_history WHERE draw_round = ?", (nxt,))}
    assert "v6_spread:hot" in methods and "stats_hot" in methods


def test_module_validation_and_api(iso):
    from fastapi.testclient import TestClient

    from app.main import app

    mv = R.module_validation(null_runs=2)
    assert mv["nested_cv"]["time_order"] in ("ok", "issue_unsorted_samples")
    assert "null_gate_false_adoption" in mv["v1"]
    j = TestClient(app).get("/api/v1/pipeline/reverse/report").json()
    assert "probability" in j and "approved_models" in j
