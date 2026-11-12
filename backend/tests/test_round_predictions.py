"""회차별 예측 기록·평가 테스트 — 누수 없음, 사전 예측 불변·마감 거부, 자동 평가, 성능 지표."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.ingest import db
from app.ingest import predictions as P


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    db.reset_for_tests()
    P.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()
    P.reset_for_tests()


def test_backtest_uses_only_prior_rounds_and_is_idempotent(iso):
    out = P.backtest_stats(first=1200)
    assert out["written"] > 0
    rows = db.query("SELECT draw_round, training_data_range, training_sample_count FROM round_prediction_history")
    for rnd, rng, cnt in rows:
        if rng != "none":
            last = int(rng.split("-")[1])
            assert last < rnd  # 예측 회차 이전 데이터만
            assert cnt == rnd - 1
    assert P.backtest_stats(first=1200)["written"] == 0  # 재실행해도 중복 저장 없음


def test_backtest_matches_full_history_engine(iso):
    """예측 기록의 전략 일치 수가 기존 전체 이력 백테스트 엔진의 회차별 채점과 같다."""
    from app.stats_engine.backtest import _walk_forward
    from app.stats_engine.draws import load_draws

    P.backtest_stats(first=51)
    P.evaluate_pending()
    draws = load_draws()
    per, tested = _walk_forward(draws, [6], 50)
    got = {r: m for r, m in db.query(
        "SELECT e.draw_round, e.match_count FROM round_prediction_evaluation e JOIN round_prediction_history h "
        "ON h.prediction_id = e.prediction_id WHERE h.prediction_method = 'stats_hot'")}
    for i, rnd in enumerate(tested[-50:]):
        assert got[rnd] == per["hot"][6][len(tested) - 50 + i]


def test_live_refused_after_cutoff_and_immutable(iso, monkeypatch):
    import app.ingest.predictions as mod

    monkeypatch.setattr(mod, "draw_cutoff", lambda r: datetime(2099, 1, 1, tzinfo=timezone.utc))
    from app.stats_engine.draws import load_draws

    nxt = load_draws()[-1].round + 1
    a = P.create_live(nxt, include_ensemble=False)
    assert a["status"] == "ok" and a["written"] > 0
    before = db.query("SELECT prediction_id, predicted_numbers, prediction_created_at FROM round_prediction_history "
                      "WHERE prediction_type = 'live' ORDER BY prediction_id")
    b = P.create_live(nxt, include_ensemble=False)
    assert b["written"] == 0  # 저장 후 변경·추가 없음
    after = db.query("SELECT prediction_id, predicted_numbers, prediction_created_at FROM round_prediction_history "
                     "WHERE prediction_type = 'live' ORDER BY prediction_id")
    assert before == after
    monkeypatch.setattr(mod, "draw_cutoff", lambda r: datetime(2000, 1, 1, tzinfo=timezone.utc))
    assert P.create_live(nxt + 1, include_ensemble=False)["status"] == "refused_after_cutoff"


def test_evaluation_and_round_detail(iso):
    from app.stats_engine.draws import load_draws

    last = load_draws()[-1]
    with db.transaction() as c:
        P._ensure()
    with db.transaction() as c:
        P.save_prediction(c, rnd=last.round, method="random_baseline", ptype="backtest",
                          numbers=list(last.numbers), engine_version="t")
        assert not P.save_prediction(c, rnd=last.round, method="x", ptype="backtest", numbers=[1, 1, 2, 3, 4, 5],
                                     engine_version="t")  # 무효 조합 거부
    assert P.evaluate_pending()["evaluated"] == 1
    d = P.round_detail(last.round)
    p = d["predictions"][0]
    assert p["match_count"] == 6 and p["prize_tier"] == 1 and d["winning"] == list(last.numbers)
    assert P.evaluate_pending()["evaluated"] == 0  # 재평가 없음


def test_performance_metrics_and_common_rounds(iso):
    P.backtest_stats(first=1150)
    P.evaluate_pending()
    perf = P.performance("backtest", common_only=True)
    assert perf["theoretical"]["mean_matches"] == 0.8
    names = {m["method"] for m in perf["methods"]}
    assert "random_baseline" in names and "stats_hot" in names
    n = {m["rounds"] for m in perf["methods"]}
    assert len(n) == 1  # 공통 회차 → 모든 엔진 같은 표본
    for m in perf["methods"]:
        assert abs(sum(m["match_rates"].values()) - 1) < 1e-3
        assert m["ci95"][0] <= m["mean_matches"] <= m["ci95"][1]


def test_cutoff_is_saturday_2000_kst():
    c = P.draw_cutoff(1249)
    assert c.isoformat() == "2026-11-07T11:00:00+00:00"


def test_prediction_api(iso):
    from fastapi.testclient import TestClient

    from app.main import app

    P.backtest_stats(first=1240)
    P.evaluate_pending()
    cl = TestClient(app)
    assert cl.get("/api/v1/pipeline/predictions/round/1245").json()["predictions"]
    assert cl.get("/api/v1/pipeline/predictions/performance?ptype=backtest").status_code == 200
    assert cl.get("/api/v1/pipeline/predictions/search?min_match=2&limit=5").status_code == 200


def test_boot_releases_locks_from_previous_container(iso):
    from app.ingest import jobs

    with db.transaction() as c:
        c.execute("INSERT INTO reg_locks (name, owner, expires_at) VALUES (?,?,?)", ("job:x", "oldhost:1", 9e12))
        c.execute("INSERT INTO reg_jobs (id,name,status,attempt,started_at) VALUES (?,?,?,?,?)", ("j1", "x", "running", 1, "t"))
    assert jobs.release_locks_from_previous_containers() == 1
    assert jobs.acquire_lock("job:x")
    assert db.query("SELECT status FROM reg_jobs WHERE id = 'j1'")[0][0] == "aborted_restart"


def test_consensus_ranking_round_and_all_rounds(tmp_path, monkeypatch):
    from app.ingest import db
    from app.ingest import predictions as P

    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    db.reset_for_tests()
    P.reset_for_tests()
    P.backtest_stats(first=1150)
    P.evaluate_pending()
    out = P.consensus_ranking(1200)
    b = out["backtest"]
    assert b["engine_count"] == 6  # 회차통계 6전략(무작위 기준선 제외)
    ranks = [x["engines"] for x in b["numbers"]]
    assert ranks == sorted(ranks, reverse=True) and all(x["drawn"] is not None for x in b["numbers"])
    lv = out["all_rounds"]["by_engine_count"]
    assert lv and sum(x["picks"] for x in lv) > 0 and all(0 <= x["hit_rate"] <= 1 for x in lv)
    assert "당첨 확률" in out["note"]
    db.reset_for_tests()
    P.reset_for_tests()
