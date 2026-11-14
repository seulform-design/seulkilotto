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
    a = out["all_rounds"]
    # 회차별 기준: 선택 회차 이전만, 회차가 바뀌면 통계 범위도 바뀜(전체 누적 아님)
    assert a["basis"] == "per_round_rows" and a["rounds"] == 50 and a["range"] == "1150~1199회"
    assert all(h["round"] < 1200 for h in a["recent_history"]) and a["recent_history"][0]["round"] == 1199
    assert a["selected_round_track"] and all("past_times_top" in x for x in a["selected_round_track"])
    # 회차별 행: 이전 모든 회차가 한 줄씩, 각 회차 자체의 중복 수별 선택/당첨 — 합계가 누적 비율과 일치
    pr = a["per_round"]
    assert len(pr) == 30 and pr[0]["round"] == 1199 and pr[-1]["round"] == 1170
    assert all(row["multi_hits"] == sum(v["hits"] for v in row["levels"].values()) for row in pr)
    tr_ = out["this_round"]
    assert tr_["round"] == 1200 and tr_["result_known"] and tr_["multi_picks"] == len(b["multi_engine_numbers"])
    assert tr_["multi_hits"] == b["multi_engine_hits"]
    t10 = out["top10"]
    assert len(t10["backtest"]["numbers"]) == 10 and [x["rank"] for x in t10["backtest"]["numbers"]] == list(range(1, 11))
    sc = [x["score"] for x in t10["backtest"]["numbers"]]
    assert sc == sorted(sc, reverse=True) and t10["backtest"]["hits"] == sum(x["drawn"] for x in t10["backtest"]["numbers"])
    v = t10["validation"]
    assert v["rounds"] == 49 and v["random_mean_hits"] == 1.333 and all(h["round"] < 1200 for h in t10["recent"])
    assert t10["engine_weights"] and "1/8,145,060" in t10["honesty"]
    pz = out["pairs"]
    pb = pz["backtest"]
    assert len(pb["top10"]) == 10 and [x["rank"] for x in pb["top10"]] == list(range(1, 11))
    assert all(x["engines"] >= 2 for x in pb["overlap_pairs"]) and pb["overlap_pairs_total"] >= len(pb["overlap_pairs"])
    assert [x["engines"] for x in pb["overlap_pairs"]] == sorted((x["engines"] for x in pb["overlap_pairs"]), reverse=True)
    assert pb["pair_hits"] == sum(1 for x in pb["top10"] if x["drawn"] == 2)
    pv = pz["validation"]
    assert pv["rounds"] == 49 and pv["random_rate"] == 0.0152 and all(h["round"] < 1200 for h in pz["recent"])
    assert all(x["both_drawn"] <= x["times_consensus"] for x in pz["all_rounds"]["most_frequent"])
    assert "1/8,145,060" in pz["honesty"]
    for key, k in (("triples", 3), ("quads", 4)):
        q = out[key]
        assert q["k"] == k and abs(q["random_all_drawn"] - P._p_all_drawn(k)) < 1e-6
        assert all(len(x["set"]) == k and x["engines"] >= 2 for x in q["backtest"]["overlap_sets"])
        assert all(len(x["set"]) == k and x["engines"] >= 2 for x in q["backtest"]["top10"])
        assert q["validation"]["random_drawn_per_set"] == round(k * 6 / 45, 4) and all(h["round"] < 1200 for h in q["recent"])
    assert abs(P._p_all_drawn(2) - P.PAIR_P) < 1e-12 and abs(P._p_all_drawn(3) - 120 / 85140) < 1e-12
    a2 = P.consensus_ranking(1180)["all_rounds"]
    assert a2["rounds"] == 30 and a2["range"] == "1150~1179회" and a2["per_round"][0]["round"] == 1179
    db.reset_for_tests()
    P.reset_for_tests()
