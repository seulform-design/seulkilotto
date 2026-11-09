"""자동 수집·검증 파이프라인 테스트 (모의 데이터 — 외부 네트워크 불사용).

실데이터(동행복권 공식·유튜브 RSS·썸네일 OCR) 검증은 네트워크가 필요해 이 파일에 넣지 않고
별도 실측으로 보고한다. 여기서는 규칙(검증 게이트·중복 차단·롤백·잠금·누수 방지)을 고정한다.
"""
from __future__ import annotations

import csv
import sqlite3
import time

import pytest

from app.ingest import db, jobs, registry, tickets, youtube
from app.ingest.official import OfficialDraw, OfficialError


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    """격리된 레지스트리 DB + CSV(실 CSV 앞 60회 복사)."""
    from app.database import CSV_DATA_PATH

    csv_path = tmp_path / "hist.csv"
    with open(CSV_DATA_PATH, encoding="utf-8") as src:
        lines = src.read().splitlines()[:61]
    csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    monkeypatch.setenv("INGEST_CSV_PATH", str(csv_path))
    monkeypatch.setenv("INGEST_DISABLE_SECONDARY", "1")
    db.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()


def _off(rnd, nums=(1, 2, 3, 4, 5, 6), bonus=7, date="2003-02-01"):
    return OfficialDraw(rnd, list(nums), bonus, date, {"1": {"winners": 1}, "total_sales": 1000000})


def _csv_rounds(p):
    with open(p, encoding="utf-8") as fp:
        return [int(r["round"]) for r in csv.DictReader(fp)]


# ───────────── 유튜브 텍스트 추출 ─────────────

def test_youtube_extract_result_with_numbers():
    r = youtube.extract_from_text("로또 1249회 당첨번호 2, 11, 16, 25, 34, 35 보너스 14 (2026년 11월 7일)")
    assert r["round"] == 1249 and r["numbers"] == [2, 11, 16, 25, 34, 35] and r["bonus"] == 14
    assert r["draw_date"] == "2026-11-07" and r["kind"] == "result" and r["confidence"] >= 0.9


def test_youtube_extract_ignores_prediction_and_other_lottery():
    assert youtube.extract_from_text("1250회 로또 (1249회: 2,11,34 적중!)")["numbers"] is None
    assert youtube.extract_from_text("1250회 로또 예상번호 1 2 3 4 5 6 보너스 7")["kind"] == "prediction"
    assert youtube.extract_from_text("연금복권 340회 당첨번호, 11월5일")["kind"] == "other_lottery"


def test_youtube_rss_parse():
    xml = ("<feed><entry><yt:videoId>abc</yt:videoId><yt:channelId>C1</yt:channelId><title>로또 1249회 당첨번호, 11월7일"
           "</title><published>2026-11-07T12:00:00+00:00</published><media:description>d</media:description></entry></feed>")
    v = youtube.parse_rss(xml, "ch")
    assert v[0].video_id == "abc" and v[0].url.endswith("v=abc")


# ───────────── 검증·저장 규칙 ─────────────

def test_commit_only_when_official_matches_and_blocks_duplicate(iso):
    registry.seed_from_csv()
    res = registry.ingest_round(61, _off(61))
    assert res["status"] == "committed" and res["csv_added"] == [61]
    assert _csv_rounds(iso / "hist.csv")[-1] == 61
    assert registry.ingest_round(61, _off(61))["status"] == "duplicate"
    assert _csv_rounds(iso / "hist.csv").count(61) == 1
    hist = db.query("SELECT action FROM reg_history WHERE round = 61")
    assert ("commit",) in hist


def test_youtube_mismatch_goes_to_review_not_db(iso):
    v = youtube.VideoMeta("vid1", "c", "ch", "로또 61회 당첨번호 1 2 3 4 5 9 보너스 7", "", "2003-02-01T00:00:00Z")
    v.extracted = youtube.extract_from_text(v.title, "", 2003)
    registry.record_youtube([v])
    res = registry.ingest_round(61, _off(61))
    assert res["status"] == "pending_review" and "youtube:vid1" in res["mismatches"]
    assert 61 not in _csv_rounds(iso / "hist.csv")
    assert registry.get_draw(61) is None
    assert registry.staging("pending_review")[0]["round"] == 61


def test_youtube_numbers_match_marks_numbers_matched(iso):
    v = youtube.VideoMeta("vid2", "c", "ch", "로또 61회 당첨번호 1 2 3 4 5 6 보너스 7 (2003년 2월 1일)", "", "2003-02-01T00:00:00Z")
    v.extracted = youtube.extract_from_text(v.title, "", 2003)
    registry.record_youtube([v])
    res = registry.ingest_round(61, _off(61))
    assert res["status"] == "committed" and res["youtube_check"] == "numbers_matched" and res["video_id"] == "vid2"


def test_official_unreachable_is_unverified_only(iso):
    res = registry.ingest_round(61, None, official_error="network")
    assert res["status"] == "unverified"
    assert registry.get_draw(61) is None and 61 not in _csv_rounds(iso / "hist.csv")
    # 반복 수집해도 스테이징 중복 적재 안 함
    registry.ingest_round(61, None, official_error="network")
    assert len(registry.staging("unverified")) == 1


def test_existing_value_never_overwritten(iso):
    registry.seed_from_csv()
    before = registry.get_draw(10)
    wrong = _off(10, nums=(1, 2, 3, 4, 5, 6), bonus=7, date=before["draw_date"])
    res = registry.verify_existing({10: wrong})
    assert res["conflicts"] == [10]
    assert registry.get_draw(10)["numbers"] == before["numbers"]  # 덮어쓰기 없음
    ok = _off(10, nums=before["numbers"], bonus=before["bonus"], date=before["draw_date"])
    assert registry.verify_existing({10: ok})["newly_verified"] == 1
    assert registry.get_draw(10)["verification_status"] == registry.STATUS_VERIFIED


def test_csv_failure_rolls_back_db(iso, monkeypatch):
    def boom(_):
        raise OSError("disk full")

    monkeypatch.setattr(registry, "append_csv_rows", boom)
    with pytest.raises(OSError):
        registry.ingest_round(61, _off(61))
    assert registry.get_draw(61) is None  # 트랜잭션 롤백


def test_restore_csv_from_registry_after_reset(iso):
    registry.ingest_round(61, _off(61))
    p = iso / "hist.csv"
    lines = p.read_text(encoding="utf-8").splitlines()
    p.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")  # 재배포로 CSV 가 되돌아간 상황
    assert registry.restore_csv_from_registry() == [61]
    assert _csv_rounds(p)[-1] == 61


def test_sync_rounds_with_mocked_sources(iso, monkeypatch):
    from app.ingest import official

    monkeypatch.setattr(youtube, "discover", lambda round_hint=None: {"videos": [], "errors": [
        {"channel": "api_search", "kind": "no_api_key", "error": ""}]})
    monkeypatch.setattr(official, "fetch_latest_round", lambda known: 62)

    def fr(r, **kw):
        if r == 62:
            raise OfficialError("not_published", "x")
        return _off(r)

    monkeypatch.setattr(official, "fetch_round", fr)
    out = jobs.sync_rounds()
    assert out["new_rounds"] == [61]
    assert [r["status"] for r in out["results"]] == ["committed", "not_published"]
    assert out["youtube_api"] == "rss_only"


def test_sync_rounds_official_down_stages_youtube_round(iso, monkeypatch):
    from app.ingest import official

    v = youtube.VideoMeta("vid3", "c", "ch", "로또 61회 당첨번호, 2월1일", "", "2003-02-01T00:00:00Z")
    v.extracted = youtube.extract_from_text(v.title, "", 2003)
    monkeypatch.setattr(youtube, "discover", lambda round_hint=None: {"videos": [v], "errors": []})

    def down(_):
        raise OfficialError("blocked", "html")

    monkeypatch.setattr(official, "fetch_latest_round", down)
    out = jobs.sync_rounds()
    assert out["official_latest"] is None and out["results"][0]["status"] == "unverified"
    assert 61 not in _csv_rounds(iso / "hist.csv")


# ───────────── 잠금·재시도 ─────────────

def test_lock_prevents_duplicate_and_reclaims_orphan(iso):
    assert jobs.acquire_lock("t", ttl_sec=60)
    assert not jobs.acquire_lock("t", ttl_sec=60)
    jobs.release_lock("t")
    assert jobs.acquire_lock("t2", ttl_sec=-1)  # 즉시 만료(고아)
    assert jobs.acquire_lock("t2", ttl_sec=60)  # 회수 후 재획득


def test_run_job_retries_transient_and_records(iso):
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise OfficialError("network", "down")
        return {"ok": True}

    r = jobs.run_job("flaky", flaky, retries=2, backoff=0)
    assert r["status"] == "success" and r["attempt"] == 2
    kinds = [x[0] for x in db.query("SELECT error_kind FROM reg_jobs WHERE name='flaky' AND status='failed'")]
    assert kinds == ["network"]


def test_run_job_does_not_retry_permanent(iso):
    calls = {"n": 0}

    def bad():
        calls["n"] += 1
        raise OfficialError("parse", "bad")

    r = jobs.run_job("bad", bad, retries=3, backoff=0)
    assert r["status"] == "failed" and r["error_kind"] == "parse" and calls["n"] == 1


# ───────────── 엔진·백테스트 ─────────────

def test_learning_engines_report_data_insufficient_without_sheets(iso, monkeypatch):
    import app.video_analysis.feature_learning_engine as fle

    monkeypatch.setattr(fle, "collect_round_samples", lambda: [])
    out = jobs.learning_engines()
    assert out["input_samples"] == 0
    st = {e["engine"]: e["status"] for e in jobs.engines()}
    assert all(st[k] == jobs.S_NODATA for k in jobs.LEARNING_ENGINES)


def test_backtest_log_no_lookahead_and_idempotent(iso):
    out = jobs.backtest_log(last_n=5)
    assert out["written"] == 5 * 6
    rows = db.query("SELECT round, data_last_round, matches FROM reg_backtest_log")
    assert all(dl < r for r, dl, _ in rows)  # 예측에 쓴 데이터는 그 회차 이전뿐
    assert jobs.backtest_log(last_n=5)["written"] == 0  # 중복 저장 없음


def test_stats_refresh_skips_same_data_and_checks_consistency(iso):
    first = jobs.stats_refresh()
    assert first["consistency"]["consistent"] is True
    second = jobs.stats_refresh()
    assert second["window_stats"].startswith("skip")


# ───────────── 앙상블 파라미터 ─────────────

def _ensemble(monkeypatch, strong=False, **kw):
    import app.prediction_signals as ps
    from app.analytics import generate_ensemble_sets
    from app.database import load_history

    ranked = [{"number": n, "sources": (["machine-reversion"] if n % 3 == 0 else ["classic-blend"] if n % 3 == 1 else ["decade-gap"])}
              for n in range(1, 46)]
    per_round = {
        # machine: 최근 회차에 적중이 몰림, classic: 오래된 회차에 몰림
        "machine": {"available": True, "per_round": [{"hits": (5 if strong else (0 if i < 15 else 5)), "predicted": list(range(1, 11))} for i in range(20)]},
        "classic": {"available": True, "per_round": [{"hits": 5 if i < 5 else 0, "predicted": list(range(1, 11))} for i in range(20)]},
    }
    monkeypatch.setattr(ps, "build_prediction_signals", lambda **k: {"target_round": 9999, "ranked_numbers": ranked})
    monkeypatch.setattr(ps, "backtest_signal_accuracy", lambda *a, **k: {"available": True, "by_source": per_round})
    return generate_ensemble_sets(load_history(), n_sets=5, seed=1, **kw)


def test_lambda_reg_shrinks_toward_equal(monkeypatch):
    r0 = _ensemble(monkeypatch, strong=True, lambda_reg=0.0, decay_factor=1.0)
    r1 = _ensemble(monkeypatch, strong=True, lambda_reg=1.0, decay_factor=1.0)
    assert r0["rationale"]["engine_evidence"]["machine"]["significant"] is True
    w0, w1 = r0["engine_weights"], r1["engine_weights"]
    contrib = [k for k in w1 if w1[k] > 0]
    assert max(w1[k] for k in contrib) - min(w1[k] for k in contrib) < 0.2  # λ=1 → 균등
    assert max(w0.values()) > max(w1.values())
    assert r1["params"]["lambda_reg"] == 1.0


def test_decay_factor_changes_evidence(monkeypatch):
    a = _ensemble(monkeypatch, decay_factor=1.0, lambda_reg=0.0)["rationale"]["engine_evidence"]
    b = _ensemble(monkeypatch, decay_factor=0.7, lambda_reg=0.0)["rationale"]["engine_evidence"]
    assert a["machine"]["lift"] == b["machine"]["lift"]  # 원 적중 lift 는 불변
    assert b["machine"]["decayed_lift"] > a["machine"]["decayed_lift"]  # 최근 성적 가중↑
    assert b["classic"]["decayed_lift"] < a["classic"]["decayed_lift"]


# ───────────── 공동선택 회피 실측 보정 ─────────────

def test_coselection_calibration_detects_signal_and_null():
    import random

    from app.stats_engine import coselection
    from app.stats_engine.coselection_calibration import calibrate

    rng = random.Random(3)
    rows_sig, rows_null = [], []
    for r in range(100, 700):
        nums = sorted(rng.sample(range(1, 46), 6))
        risk = coselection.assess(nums)["risk"]
        games = 100_000_000
        lam3 = games * 228 / 8_145_060
        rows_sig.append({"round": r, "numbers": nums, "prizes": {"total_sales": games * 1000, "1": {"winners": 10},
                         "3": {"winners": int(lam3 * (0.5 + risk / 50))}}})
        rows_null.append({"round": r, "numbers": nums, "prizes": {"total_sales": games * 1000, "1": {"winners": 10},
                          "3": {"winners": int(lam3 * rng.uniform(0.5, 1.5))}}})
    s = calibrate(rows_sig)
    assert s["score_validated"] and "rank3" in s["validated_on"]
    n = calibrate(rows_null)
    assert n["spearman_risk_vs_rank3_popularity"]["p_value"] > 0.001


# ───────────── 유튜브 용지 ─────────────

def _line(nums, ptype="auto", ocr=0.8, tconf=0.85, valid=True, label="A"):
    return {"numbers": nums, "pick_type": ptype, "ocr_confidence": ocr, "type_confidence": tconf,
            "valid_shape": valid, "game_label": label, "label_text": label, "column": 0}


def test_ticket_gates():
    assert tickets.classify_line(_line([1, 2, 3, 4, 5, 6]), 1250) == "accepted"
    assert tickets.classify_line(_line([1, 2, 3, 4, 5, 6], valid=False), 1250) == "rejected_shape"
    assert tickets.classify_line(_line([1, 2, 3, 4, 5, 6], ptype="manual"), 1250) == "excluded_manual"
    assert tickets.classify_line(_line([1, 2, 3, 4, 5, 6], ptype="unknown"), 1250) == "pending_review"
    assert tickets.classify_line(_line([1, 2, 3, 4, 5, 6], ocr=0.3), 1250) == "pending_review"
    assert tickets.classify_line(_line([1, 2, 3, 4, 5, 6]), None) == "pending_review"
    assert tickets._label_type("A 반 자동")[0] == "semi_auto"
    assert tickets._label_type("돌")[0] == "auto"
    assert tickets.title_type_hint("1250회 첫자동") == "auto"


def test_ticket_store_dedup_and_separate_analysis(iso):
    v = {"video_id": "tv1", "url": "https://www.youtube.com/watch?v=tv1", "round_hint": 60}
    res = {"round": 60, "lines": [_line([1, 2, 3, 4, 5, 6]), _line([7, 8, 9, 10, 11, 12], ptype="semi_auto", label="B"),
                                  _line([13, 14, 15, 16, 17, 18], ptype="manual", label="C")]}
    c1 = tickets.store_lines(v, res)
    c2 = tickets.store_lines(v, res)
    assert c1["accepted"] == 2 and c1["excluded_manual"] == 1
    assert c2.get("duplicate") == 3  # 같은 영상·같은 줄 반복 추출 차단
    a = tickets.analysis()
    assert a["by_type"]["auto"]["accepted_lines"] == 1 and a["by_type"]["semi_auto"]["accepted_lines"] == 1
    cols = [r[1] for r in db.query("PRAGMA table_info(reg_tickets)")]
    assert not any(k in cols for k in ("barcode", "qr", "tr_number", "serial"))  # 식별정보 비저장


# ───────────── SQLite 보호 ─────────────

def test_sqlite_online_backup_verifies(tmp_path):
    from app.ingest.sqlite_maint import backup_and_verify

    p = tmp_path / "x.db"
    con = sqlite3.connect(p)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE t (a INTEGER)")
    con.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(100)])
    con.commit()  # 연결을 연 채 백업(활성 DB)
    rep = backup_and_verify(p, tmp_path / "bk", keep=2)
    con.close()
    assert rep["ok"] and rep["backup_integrity"] == "ok" and rep["count_mismatches"] == {}
    assert rep["source_counts"]["t"] == 100 and rep["wal_checkpoint"]["mode"] == "PASSIVE"


# ───────────── API ─────────────

def test_pipeline_api(iso):
    from fastapi.testclient import TestClient

    from app.main import app

    c = TestClient(app)
    registry.ingest_round(61, _off(61))
    st = c.get("/api/v1/pipeline/status")
    assert st.status_code == 200 and st.json()["registry"]["latest_verified_round"] == 61
    assert c.get("/api/v1/pipeline/staging").status_code == 200
    assert c.get("/api/v1/pipeline/draws/61").json()["verification_status"] == "official_verified"
    assert c.get("/api/v1/pipeline/coselection-calibration").status_code == 200
    assert c.get("/api/v1/pipeline/tickets").status_code == 200
    assert c.get("/api/v1/pipeline/backtest-log").status_code == 200
