"""전 회차 YouTube 수집 — 모의 Google API 응답으로 오류 분류·할당량·작업 큐·페이지·중복·회차 연결 검증."""
from __future__ import annotations

import io
import json
import urllib.error

import pytest

from app.ingest import db, yt_collect as Y


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    monkeypatch.delenv("YOUTUBE_API_KEY_BACKUP", raising=False)
    db.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(code, reason):
    body = json.dumps({"error": {"code": code, "errors": [{"reason": reason}]}}).encode()
    return urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(body))


def test_missing_key_is_explicit_and_jobs_not_consumed(iso):
    assert Y.key_status()["primary_present"] is False
    Y.create_round_jobs(3)
    out = Y.run_jobs()
    assert out["stopped"] == "missing_key" and out["queued"] > 0
    assert Y.diagnose()["diagnosis"] == "missing_key"


def test_key_whitespace_and_quotes_are_stripped(iso, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", '  "AIza' + "x" * 35 + '"  ')
    st = Y.key_status()
    assert st["primary_present"] and st["primary_had_whitespace_or_quotes"] and st["format_ok"] == [True]


@pytest.mark.parametrize("code,reason,kind", [
    (400, "keyInvalid", "invalid_key"), (403, "accessNotConfigured", "api_disabled"),
    (403, "quotaExceeded", "quota_exceeded"), (403, "dailyLimitExceeded", "quota_exceeded"),
    (403, "rateLimitExceeded", "rate_limited"), (403, "forbidden", "forbidden"),
    (403, "insufficientPermissions", "insufficient_permissions"), (403, "ipRefererBlocked", "key_restriction"),
    (500, "", "server_error"), (503, "", "unavailable"), (404, "", "not_found"), (429, "", "rate_limited"),
])
def test_google_error_classification(iso, monkeypatch, code, reason, kind):
    monkeypatch.setenv("YOUTUBE_API_KEY", "AIza" + "k" * 35)

    def boom(*a, **k):
        raise _http_error(code, reason)

    monkeypatch.setattr("urllib.request.urlopen", boom)
    with pytest.raises(Y.YTError) as ei:
        Y.call("videos", {"part": "id", "id": "x"})
    assert ei.value.kind == kind and ei.value.http == code
    log = db.query("SELECT error_code, http_status FROM youtube_collection_logs")[-1]
    assert log[0].startswith(kind) and log[1] == code
    # 키 값은 로그 어디에도 없다
    assert not any("kkkk" in str(r) for r in db.query("SELECT * FROM youtube_collection_logs"))


def test_backup_key_used_on_invalid_primary(iso, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "AIza" + "a" * 35)
    monkeypatch.setenv("YOUTUBE_API_KEY_BACKUP", "AIza" + "b" * 35)
    calls = []

    def fake(req, timeout=20):
        calls.append(req.full_url)
        if "aaaa" in req.full_url:
            raise _http_error(400, "keyInvalid")
        return _Resp(json.dumps({"items": [{"id": "v"}]}).encode())

    monkeypatch.setattr("urllib.request.urlopen", fake)
    assert Y.call("videos", {"part": "id", "id": "v"})["items"]
    assert len(calls) == 2


def test_quota_budget_stops_before_spending(iso, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "AIza" + "k" * 35)
    monkeypatch.setenv("YOUTUBE_DAILY_QUOTA", "150")
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=20: _Resp(json.dumps({"items": []}).encode()))
    Y.create_round_jobs(2)
    out = Y.run_jobs(max_jobs=10)
    assert out["ran"] == 1 and out["stopped"] == "quota_budget"  # search=100 units → 두 번째는 예산 초과
    assert out["quota_used_today"] == 100


def test_jobs_cover_all_rounds_with_priorities(iso):
    r = Y.create_round_jobs(1249)
    cur_n = len(Y.CURRENT_TEMPLATES) + 2
    assert r["created"] == 1249 * 16 + cur_n and r["current_round"] == 1250
    assert Y.create_round_jobs(1249)["created"] == 0  # 같은 날 중복 생성 없음
    first = db.query("SELECT draw_round FROM youtube_search_jobs ORDER BY priority LIMIT ?", (cur_n,))
    assert {x[0] for x in first} == {1250}  # 이번 회차(판매 중) 최우선
    nxt = db.query("SELECT draw_round, search_query FROM youtube_search_jobs ORDER BY priority LIMIT 1249 OFFSET ?", (cur_n,))
    # 그다음: 전 회차에 핵심 검색어 1개씩(최근→과거) — 최근 몇 회차가 할당량을 독점하지 않음
    assert [x[0] for x in nxt[:5]] == [1249, 1248, 1247, 1246, 1245]
    assert len({x[0] for x in nxt}) == 1249 and all("회 로또 자동" in x[1] for x in nxt)
    seed_pos = db.query("SELECT MIN(priority) FROM youtube_search_jobs WHERE draw_round = 1240")[0][0]
    assert db.query("SELECT MIN(priority) FROM youtube_search_jobs WHERE draw_round = 1249")[0][0] < seed_pos


def test_search_stores_dedupes_maps_rounds_paginates(iso, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "AIza" + "k" * 35)
    page = {"n": 0}

    def fake(req, timeout=20):
        page["n"] += 1
        items = [
            {"id": {"videoId": "vid00000001"}, "snippet": {"title": "1249회 로또 자동 용지", "channelId": "UCa",
                                                         "channelTitle": "A", "publishedAt": "2026-11-02T00:00:00Z"}},
            {"id": {"videoId": "vid00000002"}, "snippet": {"title": "이번주 자동 구매", "channelId": "UCb",
                                                         "channelTitle": "B", "publishedAt": "2026-11-03T00:00:00Z"}},
        ]
        return _Resp(json.dumps({"items": items, "nextPageToken": "P2" if page["n"] == 1 else None}).encode())

    monkeypatch.setattr("urllib.request.urlopen", fake)
    with db.transaction() as c:
        c.execute("INSERT INTO youtube_search_jobs (job_id,draw_round,search_query,search_type,priority,status,created_at,updated_at) "
                  "VALUES ('j1',1249,'1249회 로또','round_query',0,'queued','t','t')")
    out = Y.run_jobs(max_jobs=5)
    assert out["videos_new"] == 2
    assert db.query("SELECT COUNT(*) FROM youtube_videos")[0][0] == 2  # 같은 영상이 다음 페이지에 또 와도 중복 저장 없음
    assert db.query("SELECT COUNT(*) FROM youtube_channels")[0][0] == 2  # 새 채널 자동 등록
    m = dict(db.query("SELECT video_id, mapping_method FROM youtube_video_rounds"))
    assert m["vid00000001"] == "title_round" and m["vid00000002"] == "published_window"
    assert db.query("SELECT status FROM youtube_search_jobs WHERE job_id='j1'")[0][0] == "done_results"
    assert db.query("SELECT COUNT(*) FROM youtube_discovered_videos")[0][0] == 2  # 용지 단서 → 판독 큐


def test_no_results_distinct_from_unsearched(iso, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "AIza" + "k" * 35)
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=20: _Resp(json.dumps({"items": []}).encode()))
    with db.transaction() as c:
        for i, r in enumerate((5, 6)):
            c.execute("INSERT INTO youtube_search_jobs (job_id,draw_round,search_query,search_type,priority,status,created_at,updated_at) "
                      "VALUES (?,?,?,?,?,?,?,?)", (f"j{r}", r, f"{r}회 로또", "round_query", i, "queued", "t", "t"))
    Y.run_jobs(max_jobs=1)
    st = dict(db.query("SELECT draw_round, status FROM youtube_search_jobs"))
    assert st[5] == "done_no_results" and st[6] == "queued"
    cov = Y.coverage()
    assert cov["rounds"]["searched_any"] == 1 and cov["rounds"]["without_videos_after_search"] == 1



def test_extra_queries_skipped_for_covered_rounds(iso, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "AIza" + "x" * 35)
    Y.create_round_jobs(3)
    monkeypatch.setattr(Y, "_rounds_with_tickets", lambda: {1, 2, 3})
    calls = []
    monkeypatch.setattr(Y, "call", lambda ep, params, draw_round=None: calls.append(params["q"]) or {"items": []})
    out = Y.run_jobs(max_jobs=100)
    # 이번 회차(4)·핵심 검색어·기간 검색만 실행, 확정 회차의 추가 검색어 14개×3회차는 건너뜀
    assert out["skipped_covered"] == 3 * (len(Y.QUERY_TEMPLATES) - 1)
    assert all(("회 로또 자동" in q) or ("용지" in q) or q.startswith("4회") or q.startswith("제4회") for q in calls)
