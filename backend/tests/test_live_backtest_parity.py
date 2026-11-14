"""사전 예측(live)과 사후 재현(backtest)이 같은 데이터·같은 절차면 같은 번호를 내는지 — 회차마다 통일된 기록."""
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


def test_classic_engine_is_deterministic_per_round():
    from app.database import load_history
    from app.prediction_signals import _source_top_numbers

    df = load_history().sort_values("round")
    r = int(df["round"].max())
    prior = df[df["round"] < r]
    a = _source_top_numbers(prior, "classic", r, 6)
    assert len(a) == 6 and a == _source_top_numbers(prior, "classic", r, 6)  # 시드 고정 전엔 호출마다 달랐음


def _numbers(rnd, ptype):
    rows = db.query("SELECT prediction_method, prediction_rank, predicted_numbers FROM round_prediction_history "
                    "WHERE draw_round = ? AND prediction_type = ? AND prediction_status <> 'superseded'", (rnd, ptype))
    return {(m, rk): sorted(db.loads(n)) for m, rk, n in rows}


def test_live_equals_backtest_for_same_round(iso, monkeypatch):
    """마지막 회차 R 을 '추첨 전'이라고 가정해 사전 예측을 만들면, R 의 사후 재현과 엔진별 번호가 같다."""
    from app.stats_engine.draws import load_draws

    r = load_draws()[-1].round
    P.backtest_stats(first=r)
    P.backtest_engines(last_n=1)
    monkeypatch.setattr(P, "draw_cutoff", lambda x: datetime(2999, 1, 1, tzinfo=timezone.utc))
    assert P.create_live(r, include_ensemble=False)["status"] == "ok"
    live, bt = _numbers(r, "live"), _numbers(r, "backtest")
    keys = [k for k in live if k in bt]
    assert len(keys) >= 11  # 회차통계 6 + 무작위 + 엔진 4
    assert {k: live[k] for k in keys} == {k: bt[k] for k in keys}
    # V12: 같은 공통 절차·같은 가중치·같은 투표 엔진이면 사전 투표(live)와 사후 투표(backtest)로 같은 10조합
    draws = load_draws()
    prior = draws[:-1]
    w = M._prior_weights({}, r)
    only = M.v12_vote_methods()
    v_live = M._votes_for(r, ("live",), w, only=only)
    v_bt = M._votes_for(r, ("backtest",), w, only=only)
    assert sorted(v_live[2]) == sorted(v_bt[2])
    c_live = [c["numbers"] for c in M._v12_from_votes(r, prior, v_live[0], v_live[1])[1]]
    c_bt = [c["numbers"] for c in M._v12_from_votes(r, prior, v_bt[0], v_bt[1])[1]]
    assert c_live == c_bt and len(c_live) == 10


def test_old_classic_version_is_superseded_not_deleted(iso):
    from app.stats_engine.draws import load_draws

    r = load_draws()[-1].round
    P._ensure()
    with db.transaction() as c:
        P.save_prediction(c, rnd=r, method="engine_classic", ptype="backtest", numbers=[1, 2, 3, 4, 5, 6],
                          engine_version="signals-1.1")
    P.backtest_engines(last_n=1, sources=("classic",))
    rows = db.query("SELECT engine_version, prediction_status FROM round_prediction_history WHERE draw_round = ? "
                    "AND prediction_method = 'engine_classic'", (r,))
    st = dict(rows)
    assert st["signals-1.1"] == "superseded" and st[P.engine_version("classic")] != "superseded"


def test_engine_backfill_respects_budget_and_resumes(iso):
    first = P.backtest_engines(last_n=3, time_budget_sec=0)
    assert first["written"] <= 1 and first["remaining"] > 0
    rest = P.backtest_engines(last_n=3)
    assert rest["remaining"] == 0
    assert P.backtest_engines(last_n=3)["written"] == 0  # 재실행해도 중복 없음


def test_v12_waits_until_round_has_full_engine_set(iso):
    """최신 회차의 투표 엔진 구성이 없는 회차는 V12 를 만들지 않고 기다린다(회차마다 다른 구성으로 만들지 않음)."""
    from app.stats_engine.draws import load_draws

    last = load_draws()[-1].round
    P.backtest_stats(first=last - 30)
    P.backtest_engines(last_n=2)  # 최근 2회차만 엔진 4개 → 최신 회차 기준 구성 = 통계 6 + 엔진 4
    P.evaluate_pending()
    rep = M.v12_walk_forward(rounds=10)
    rounds = {int(r[0]) for r in db.query("SELECT DISTINCT draw_round FROM round_prediction_history "
                                          "WHERE prediction_method = 'v12_integrated'")}
    assert rounds == set()  # 직전 구간에 엔진 4개가 없는 회차뿐 → 전부 대기
    assert rep["waiting_for_engine_backfill"] == 10


def test_round_detail_reports_live_vs_backtest_consistency(iso, monkeypatch):
    from app.stats_engine.draws import load_draws

    r = load_draws()[-1].round
    P.backtest_stats(first=r)
    monkeypatch.setattr(P, "draw_cutoff", lambda x: datetime(2999, 1, 1, tzinfo=timezone.utc))
    P.create_live(r, include_ensemble=False)
    d = P.round_detail(r)
    assert d["consistency"]["compared"] >= 7 and not [x for x in d["consistency"]["different"] if x.startswith("stats_")]
