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
    assert out["nested_cv:auto"] == "insufficient_data" and out["feature_learning:auto"] == "not_connected_store_only"
    assert db.query("SELECT COUNT(*) FROM ticket_learning_history")[0][0] == 12
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
