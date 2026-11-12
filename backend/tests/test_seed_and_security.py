"""기준 영상 용지 수집 + 관리 키 보호 테스트(모의 데이터 — 네트워크 미사용)."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.ingest import db, seeds, tickets


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    db.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()


def test_video_id_parsing_and_same_video():
    for u in ("LSYXNhnsvtc", "https://www.youtube.com/watch?v=LSYXNhnsvtc", "https://youtu.be/LSYXNhnsvtc?t=3",
              "https://www.youtube.com/shorts/LSYXNhnsvtc"):
        assert seeds.video_id_from(u) == "LSYXNhnsvtc"
    with pytest.raises(ValueError):
        seeds.video_id_from("https://example.com/x")


def test_similarity_rewards_channel_format_and_ticket():
    seed = {"title": "1249자동 2부방송 깨끗한용지입니다", "channel_id": "UC1"}
    same = seeds.similarity(seed, {"title": "1250자동 1부방송 깨끗한용지", "channel_id": "UC1"}, ticket_detected=True)
    other = seeds.similarity(seed, {"title": "고양이 영상", "channel_id": "UC2"})
    assert same > 0.8 and other == 0.0


def test_draw_date_formula():
    assert seeds.draw_date(1) == "2002-12-07" and seeds.draw_date(1249) == "2026-11-07"


def _fake_pipeline(monkeypatch, lines, rnd, thumb_seed=0):
    import cv2
    import numpy as np

    def fake_thumb(vid, dest):
        p = Path(dest) / f"{vid}.png"
        rng = np.random.default_rng(thumb_seed)
        cv2.imencode(".png", (rng.random((60, 80)) * 255).astype("uint8"))[1].tofile(str(p))
        return p, "thumbnail:maxresdefault"

    monkeypatch.setattr(seeds, "fetch_thumbnail", fake_thumb)
    monkeypatch.setattr(tickets, "extract_ticket_lines", lambda img, title="": {"round": rnd, "lines": lines})


def _ln(nums, ptype="auto", label="A 자 동"):
    return {"numbers": nums, "valid_shape": True, "ocr_confidence": 0.95, "pick_type": ptype, "type_confidence": 0.9,
            "label_text": label, "game_label": label[:1], "column": 0}


def test_process_video_categories_tables_and_reupload(iso, monkeypatch):
    for vid in ("vidA0000001", "vidB0000002", "vidC0000003"):
        seeds._upsert_discovered(vid, "seed-x", {"title": "1249자동", "channel_id": "UC1"}, via="rss", similarity=0.5)
    _fake_pipeline(monkeypatch, [_ln([1, 2, 3, 4, 5, 6]), _ln([7, 8, 9, 10, 11, 12], "semi_auto", "B 반자동"),
                                 _ln([13, 14, 15, 16, 17, 18], "manual", "C 수 동")], 1249, thumb_seed=1)
    r1 = seeds.process_video("vidA0000001", "1249자동", 1249)
    assert r1["category"] == "C_same_format" and r1["round_status"] == "ticket_printed"
    assert db.query("SELECT COUNT(*) FROM ticket_auto_data")[0][0] == 1
    assert db.query("SELECT COUNT(*) FROM ticket_semi_auto_data")[0][0] == 1  # 분리 저장, 수동 제외
    semi = db.query("SELECT selected_numbers, generated_numbers FROM ticket_semi_auto_data")[0]
    assert tuple(semi) == (None, None)  # 출력 용지엔 직접 선택 번호 표시가 없어 미상
    r2 = seeds.process_video("vidB0000002", "1249자동", 1249)  # 같은 썸네일 → 재업로드
    assert r2["category"] == "B_reupload" and r2["duplicate_of"] == "vidA0000001"
    _fake_pipeline(monkeypatch, [], None, thumb_seed=7)
    assert seeds.process_video("vidC0000003", "고양이", None)["category"] == "D_low_relevance"
    assert db.query("SELECT COUNT(*) FROM ticket_auto_data")[0][0] == 1


def test_template_thumbnails_without_ticket_are_not_reuploads(iso, monkeypatch):
    for vid in ("vidT0000001", "vidT0000002"):
        seeds._upsert_discovered(vid, "seed-x", {"title": "x"}, via="rss", similarity=0.1)
    _fake_pipeline(monkeypatch, [], None, thumb_seed=99)
    assert seeds.process_video("vidT0000001", "x", None)["category"] == "D_low_relevance"
    assert seeds.process_video("vidT0000002", "x", None)["category"] == "D_low_relevance"


def test_round_conflict_is_not_confirmed(iso, monkeypatch):
    seeds._upsert_discovered("vidD0000004", "seed-x", {"title": "1250자동"}, via="rss", similarity=0.5)
    _fake_pipeline(monkeypatch, [_ln([1, 2, 3, 4, 5, 6])], 1249, thumb_seed=3)
    r = seeds.process_video("vidD0000004", "1250자동", 1250)
    assert r["round_status"] == "conflict_title_vs_ticket"
    assert db.query("SELECT verification_status FROM ticket_auto_data")[0][0] == "pending_review"


def test_queue_skips_processed_and_learning_needs_data(iso, monkeypatch):
    seeds._upsert_discovered("vidE0000005", "seed-x", {"title": "1249자동"}, via="seed", similarity=1.0)
    _fake_pipeline(monkeypatch, [_ln([1, 2, 3, 4, 5, 6])], 1249, thumb_seed=4)
    assert seeds.process_queue(limit=5)["processed"] == 1
    assert seeds.process_queue(limit=5)["processed"] == 0  # 이미 분석한 영상 재처리 안 함
    out = seeds.run_learning()
    assert out["nested_cv:auto"] == "insufficient_data"  # 자동/반자동 분리 실행: 추첨 완료 확정 회차 부족
    assert "engines" in out and set(seeds.LEARNING_LINK.values()) == {"connected"}  # 6종 모두 유튜브 입력 연결
    assert db.query("SELECT COUNT(*) FROM ticket_learning_history")[0][0] == 6 + 4
    d = seeds.dashboard()
    assert d["auto"].get("accepted") == 1 and d["frames_with_ticket"] == 1


def test_learning_runs_on_drawn_rounds(iso, monkeypatch):
    for i, rnd in enumerate((1246, 1247, 1248, 1249)):
        vid = f"vidL000000{i}"
        seeds._upsert_discovered(vid, "seed-x", {"title": f"{rnd}자동"}, via="rss", similarity=0.5)
        _fake_pipeline(monkeypatch, [_ln([1 + i, 9, 17, 25, 33, 41]), _ln([2, 10 + i, 18, 26, 34, 42], label="B 자 동")],
                       rnd, thumb_seed=10 + i)
        seeds.process_video(vid, f"{rnd}자동", rnd)
    assert len(seeds.youtube_round_samples("auto")) == 4
    out = seeds.run_learning()
    assert out["nested_cv:auto"] in ("completed", "insufficient_data_engine", "failed")
    assert out["shap_drift:auto"] in ("completed", "insufficient_data_engine", "failed")
    assert out["nested_cv:semi_auto"] == "insufficient_data"


# ─────────────── 관리 키 ───────────────

@pytest.fixture()
def client_with_key(monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "UPGRADE_API_KEY", "unit-test-key")
    return TestClient(app)


@pytest.mark.parametrize("method,path", [
    ("post", "/api/v1/pipeline/run"), ("post", "/api/v1/pipeline/verify-history"),
    ("post", "/api/v1/pipeline/learning/run"), ("post", "/api/v1/pipeline/tickets/scan"),
    ("post", "/api/v1/pipeline/seeds/run"), ("post", "/api/v1/pipeline/seeds/register?url=LSYXNhnsvtc"),
    ("post", "/api/v1/data/upgrade"), ("post", "/api/v1/datasets/rollover"),
    ("delete", "/api/v1/photo-analysis/store"), ("delete", "/api/v1/photo-analysis/store/x"),
    ("post", "/api/v1/photo-analysis/reattribute"), ("post", "/api/v1/photo-analysis/vision-config"),
    ("delete", "/api/v1/photo-analysis/vision-config"), ("patch", "/api/v1/photo-analysis/vision-config"),
    ("post", "/api/v1/photo-analysis/manual"), ("post", "/api/v1/photo-analysis/analyze"),
])
def test_mutating_endpoints_reject_without_key(client_with_key, method, path):
    r = getattr(client_with_key, method)(path)
    assert r.status_code in (401, 403), (path, r.status_code)
    r2 = getattr(client_with_key, method)(path, headers={"X-Upgrade-Key": "wrong"})
    assert r2.status_code in (401, 403)


def test_reads_stay_open_with_key(client_with_key):
    assert client_with_key.get("/api/v1/pipeline/status").status_code == 200
    assert client_with_key.post("/api/v1/analyze/combination", json={"numbers": [1, 2, 3, 4, 5, 6]}).status_code == 200


def test_destructive_delete_refused_when_key_unset(monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "UPGRADE_API_KEY", "")
    assert TestClient(app).delete("/api/v1/photo-analysis/store").status_code == 503


def test_internal_scheduler_does_not_use_http_auth():
    """내부 스케줄러는 HTTP 보호 API 를 호출하지 않고 작업 함수를 직접 부른다."""
    src = Path(__file__).resolve().parents[1].joinpath("app", "scheduler.py").read_text(encoding="utf-8")
    assert "X-Upgrade-Key" not in src and "urlopen" not in src and "requests." not in src


def test_engines_learn_from_youtube_tickets_via_source_switch(iso, monkeypatch):
    """6종 엔진 입력원: youtube(기본) — 확정·회차인쇄 용지만, manual — 기존 보관만, 수동 데이터는 보존."""
    from app.video_analysis import ticket_source
    from app.video_analysis.feature_learning_engine import collect_round_samples
    from app.video_analysis.store import _manual_saved_lines

    for i, rnd in enumerate((1246, 1247, 1248)):
        vid = f"vidY000000{i}"
        seeds._upsert_discovered(vid, "seed-x", {"title": f"{rnd}자동"}, via="rss", similarity=0.5)
        _fake_pipeline(monkeypatch, [_ln([1 + i, 9, 17, 25, 33, 41]), _ln([2, 10, 18, 26, 34, 42 - i], "semi_auto", "B 반자동")],
                       rnd, thumb_seed=20 + i)
        seeds.process_video(vid, f"{rnd}자동", rnd)
    monkeypatch.setenv("TICKET_LEARNING_SOURCE", "youtube")
    b = ticket_source.youtube_batches()
    assert [x["round_no"] for x in b] == [1246, 1247, 1248]
    assert _manual_saved_lines(b[0]["entries"], "자동") == [[1, 9, 17, 25, 33, 41]]
    assert _manual_saved_lines(b[0]["entries"], "반자동") == [[2, 10, 18, 26, 34, 42]]
    samples = collect_round_samples()
    assert sorted(s.round_no for s in samples) == [1246, 1247, 1248]
    assert all(s.auto_lines and s.semi_lines for s in samples)
    sig1 = ticket_source.signature()
    monkeypatch.setenv("TICKET_LEARNING_SOURCE", "manual")
    assert ticket_source.learning_batches({"archived_current_rounds": [{"round_no": 1}]}) == [{"round_no": 1}]
    assert ticket_source.signature() != sig1


def test_current_round_apply_uses_youtube_tickets_not_past_demo(iso, monkeypatch):
    """이번 회차(추첨 전) 유튜브 확정 용지가 있으면 엔진 '적용' 입력이 그 용지 — 지난 회차 시연으로 떨어지지 않는다."""
    from app.ingest import predictions as P
    from app.video_analysis import draw_template, store

    cur = draw_template.get_current_round_no()
    seeds._upsert_discovered("vidCUR00001", "seed-x", {"title": f"{cur}자동"}, via="rss", similarity=0.5)
    _fake_pipeline(monkeypatch, [_ln([3, 11, 19, 27, 35, 43]), _ln([4, 12, 20, 28, 36, 44], "semi_auto", "B 반자동")],
                   cur, thumb_seed=77)
    seeds.process_video("vidCUR00001", f"{cur}자동", cur)
    monkeypatch.setenv("TICKET_LEARNING_SOURCE", "youtube")
    ap = store._load_apply_sheet("current_round")
    assert ap["round_no"] == cur and ap["source"] == "youtube_current_round"
    assert ap["auto_lines"] == [[3, 11, 19, 27, 35, 43]] and ap["semi_lines"] == [[4, 12, 20, 28, 36, 44]]
    P.reset_for_tests()
    P.youtube_ticket_predictions()
    rows = db.query("SELECT prediction_type FROM round_prediction_history WHERE draw_round = ? "
                    "AND prediction_method = 'youtube_v3_support'", (cur,))
    assert rows and rows[0][0] in ("live", "historical_replay")
    monkeypatch.setenv("TICKET_LEARNING_SOURCE", "manual")
    assert store._load_apply_sheet("current_round")["source"] == "current_round"



def test_title_round_confirmed_only_when_uploaded_in_draw_week(iso, monkeypatch):
    assert seeds._title_round_matches_upload(1249, "2026-11-05T10:00:00Z")  # 1249회 추첨 11-07 직전
    assert seeds._title_round_matches_upload(1249, "2026-11-09T10:00:00Z")  # 추첨 +2일(결과 인증)
    assert not seeds._title_round_matches_upload(1249, "2026-10-20T10:00:00Z")  # 3주 전 — 다른 회차일 수 있음
    assert not seeds._title_round_matches_upload(None, "2026-11-05T10:00:00Z")
    # 용지에 회차 인쇄가 안 읽혀도(제목+업로드 주간 일치) 확정 → 학습 입력
    seeds._upsert_discovered("vidTD000001", "seed-x", {"title": "1248회 자동 5게임", "published_at": "2026-10-30T09:00:00Z"},
                             via="rss", similarity=0.5)
    _fake_pipeline(monkeypatch, [_ln([5, 11, 19, 27, 35, 43])], None, thumb_seed=91)
    r = seeds.process_video("vidTD000001", "1248회 자동 5게임", 1248, "2026-10-30T09:00:00Z")
    assert r["round_status"] == "title_date_confirmed"
    st = db.query("SELECT verification_status FROM ticket_auto_data WHERE video_id = 'vidTD000001'")[0][0]
    assert st == "accepted"
    # 업로드 주간이 안 맞으면 보류(pending_review) — 학습 제외
    seeds._upsert_discovered("vidTD000002", "seed-x", {"title": "1248회 자동"}, via="rss", similarity=0.5)
    _fake_pipeline(monkeypatch, [_ln([6, 12, 20, 28, 36, 44])], None, thumb_seed=92)
    r2 = seeds.process_video("vidTD000002", "1248회 자동", 1248, "2026-09-01T09:00:00Z")
    assert r2["round_status"] == "title_only_unconfirmed"


def test_queue_order_current_round_then_uncovered_rounds(iso, monkeypatch):
    from app.video_analysis import draw_template

    cur = draw_template.get_current_round_no()
    for vid, rh in (("vidQ0000001", 1100), ("vidQ0000002", cur), ("vidQ0000003", 1200), ("vidQ0000004", None),
                    ("vidQ0000005", 1200)):
        seeds._upsert_discovered(vid, "seed-x", {"title": f"{rh}회 자동" if rh else "로또 자동"}, via="rss", similarity=0.5)
        with db.transaction() as c:
            c.execute("UPDATE youtube_discovered_videos SET round_hint = ? WHERE video_id = ?", (rh, vid))
    monkeypatch.setattr(seeds, "_covered_rounds", lambda: {1100})
    order = [r[0] for r in seeds.queue_order(10)]
    assert order[0] == "vidQ0000002"  # 이번 회차
    assert order.index("vidQ0000003") < order.index("vidQ0000001")  # 확정 없는 1200회 > 이미 있는 1100회
    assert order.index("vidQ0000005") > order.index("vidQ0000001") or order.index("vidQ0000005") > order.index("vidQ0000003")
    assert order[-1] == "vidQ0000004"  # 회차 단서 없음 마지막
