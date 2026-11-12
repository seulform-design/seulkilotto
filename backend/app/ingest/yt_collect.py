"""전 회차(1~최신) YouTube 영상 수집 — YouTube Data API v3 + 할당량 관리 + 작업 큐 + 진단.

2026-11-10 장애 원인(실측)
-----------------------
- Railway 서비스 변수에 YOUTUBE_API_KEY(및 대체 이름)가 **없음** → 코드가 API 를 호출하지 못하고 RSS 로만 동작.
- 키 없이 videos.list 호출 시 Google 이 403 PERMISSION_DENIED(ACCESS_DENIED) 반환.
→ 키는 사용자 Google Cloud 프로젝트에서 발급해 Railway 변수로 넣어야 한다(코드로 만들 수 없음).

키 읽기: YOUTUBE_API_KEY → 실패(keyInvalid/할당량) 시 YOUTUBE_API_KEY_BACKUP. YOUTUBE_API_ENABLED=0 이면 끔.
앞뒤 공백·따옴표는 제거. 키 값은 로그·응답에 절대 넣지 않는다(요청 URL 기록 시 key 파라미터 제거).

할당량(기본 10,000 units/일, 태평양시 자정 리셋): search.list=100, videos/channels/playlistItems.list=1.
전 회차 × 15 검색어 = 약 18,700 회 search.list = 약 187일 분량 → 우선순위 큐로 나눠 실행하고, 진행률·미검색 회차를
그대로 보고한다. 검색 API 는 모든 공개 영상을 보장하지 않으므로 '검색 완료'≠'전수 확보'.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from . import db

API = "https://www.googleapis.com/youtube/v3/"
UNITS = {"search": 100, "videos": 1, "channels": 1, "playlistItems": 1}
QUERY_TEMPLATES = [
    "제{n}회 로또", "{n}회 로또", "{n}회차 로또 구매", "{n}회 로또 자동", "{n}회 로또 반자동", "{n}회 로또 용지",
    "{n}회 로또 구매 인증", "{n}회 로또 복권 구매", "{n}회 로또 자동 구매", "{n}회 로또 반자동 구매", "{n}회 로또 방송",
    "{n}회 로또 번호", "{n}회 로또 복기", "{n}회 로또 구매 내역", "{n}회 로또 당첨 전 구매",
]
# 이번 회차(판매 중) 검색어 — 매일 재검색하므로 할당량을 아끼려고 핵심만
CURRENT_TEMPLATES = ["{n}회 로또 자동", "{n}회 로또 반자동", "{n}회 로또 구매", "{n}회 로또 용지", "제{n}회 로또"]
SEED_ROUND = 1249
_ROUND_RE = re.compile(r"(?:제\s*)?(?<![\d/])(\d{1,4})\s*(?:회|회차)")


class YTError(Exception):
    def __init__(self, kind: str, message: str, http: Optional[int] = None, reason: str = ""):
        super().__init__(message)
        self.kind, self.http, self.reason = kind, http, reason


def _clean(v: Optional[str]) -> str:
    return (v or "").strip().strip('"').strip("'").strip()


def keys() -> List[str]:
    if _clean(os.environ.get("YOUTUBE_API_ENABLED", "1")) in ("0", "false", "False", "no"):
        return []
    return [k for k in (_clean(os.environ.get("YOUTUBE_API_KEY")), _clean(os.environ.get("YOUTUBE_API_KEY_BACKUP"))) if k]


def key_status() -> Dict[str, Any]:
    ks = keys()
    return {
        "env_vars": ["YOUTUBE_API_KEY", "YOUTUBE_API_KEY_BACKUP", "YOUTUBE_API_ENABLED"],
        "enabled": _clean(os.environ.get("YOUTUBE_API_ENABLED", "1")) not in ("0", "false", "False", "no"),
        "primary_present": bool(_clean(os.environ.get("YOUTUBE_API_KEY"))),
        "backup_present": bool(_clean(os.environ.get("YOUTUBE_API_KEY_BACKUP"))),
        "primary_had_whitespace_or_quotes": (os.environ.get("YOUTUBE_API_KEY") or "") != _clean(os.environ.get("YOUTUBE_API_KEY")),
        "format_ok": [bool(re.fullmatch(r"AIza[0-9A-Za-z_\-]{35}", k)) for k in ks],
    }


# ─────────────────────────────── 할당량 ───────────────────────────────

def _pt_day() -> str:
    """YouTube 할당량은 태평양시 자정 리셋(UTC-8 근사)."""
    return (datetime.now(timezone.utc) - timedelta(hours=8)).date().isoformat()


def quota_used_today() -> int:
    day = _pt_day()
    rows = db.query("SELECT COALESCE(SUM(quota_units),0) FROM youtube_collection_logs WHERE operation LIKE 'api:%' "
                    "AND created_at >= ?", (day,))
    return int(rows[0][0] or 0) if rows else 0


def quota_budget() -> int:
    return int(_clean(os.environ.get("YOUTUBE_DAILY_QUOTA")) or 9000)  # 기본 10,000 중 9,000만 사용(여유분)


def _log(operation: str, status: str, *, video_id: Optional[str] = None, draw_round: Optional[int] = None,
         error_code: Optional[str] = None, error_message: Optional[str] = None, http: Optional[int] = None,
         ms: Optional[float] = None, items: Optional[int] = None, units: int = 0) -> None:
    with db.transaction() as c:
        c.execute("INSERT INTO youtube_collection_logs (log_id,video_id,draw_round,operation,status,error_code,"
                  "error_message,http_status,response_ms,items,quota_units,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                  (uuid.uuid4().hex, video_id, draw_round, operation, status, error_code,
                   (error_message or "")[:500] or None, http, ms, items, units, db.now_iso()))


_KIND = {
    "keyInvalid": "invalid_key", "badRequest": "bad_request", "invalidParameter": "bad_request",
    "accessNotConfigured": "api_disabled", "SERVICE_DISABLED": "api_disabled",
    "quotaExceeded": "quota_exceeded", "dailyLimitExceeded": "quota_exceeded", "rateLimitExceeded": "rate_limited",
    "forbidden": "forbidden", "insufficientPermissions": "insufficient_permissions",
    "ipRefererBlocked": "key_restriction", "API_KEY_HTTP_REFERRER_BLOCKED": "key_restriction",
    "API_KEY_IP_ADDRESS_BLOCKED": "key_restriction", "API_KEY_SERVICE_BLOCKED": "key_restriction",
}
_RECOVERY = {
    "missing_key": "Railway → lotto-analyzer → Variables 에 YOUTUBE_API_KEY 추가(Google Cloud 에서 발급한 API 키).",
    "invalid_key": "키 값 확인 — Google Cloud Console › API 및 서비스 › 사용자 인증 정보에서 키를 다시 복사(공백·따옴표 없이).",
    "api_disabled": "Google Cloud Console › API 및 서비스 › 라이브러리 › 'YouTube Data API v3' 사용 설정(키를 만든 프로젝트에서).",
    "quota_exceeded": "오늘 할당량 소진 — 태평양시 자정 리셋 후 자동 재개. 장기적으로 할당량 증설 신청.",
    "rate_limited": "짧은 시간 요청 과다 — 간격을 두고 자동 재시도.",
    "key_restriction": "키 제한 확인 — 서버용 키는 '애플리케이션 제한: 없음 또는 IP 주소' + 'API 제한: YouTube Data API v3'. "
                       "HTTP 리퍼러(브라우저) 제한은 서버에서 거부됨.",
    "forbidden": "키를 만든 프로젝트/권한 확인(API 제한 목록에 YouTube Data API v3 포함 여부).",
    "insufficient_permissions": "OAuth 가 필요한 기능(captions.download 등) — API 키로는 불가.",
}


def call(endpoint: str, params: Dict[str, Any], *, draw_round: Optional[int] = None) -> Dict[str, Any]:
    """API 1회 호출 — 오류를 종류별로 분류해 YTError 로 올리고, 모든 시도를 로그(키 제외)로 남긴다."""
    ks = keys()
    if not ks:
        _log(f"api:{endpoint}", "failed", draw_round=draw_round, error_code="missing_key",
             error_message="YOUTUBE_API_KEY 미설정")
        raise YTError("missing_key", "YOUTUBE_API_KEY 미설정")
    units = UNITS.get(endpoint, 1)
    if quota_used_today() + units > quota_budget():
        raise YTError("quota_budget", f"오늘 예산 {quota_budget()} units 소진(내부 한도)")
    last: Optional[YTError] = None
    for i, key in enumerate(ks):
        q = {**{k: v for k, v in params.items() if v is not None}, "key": key}
        url = API + endpoint + "?" + urllib.parse.urlencode(q)
        t0 = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=20) as r:
                body = r.read()
                ms = round((time.time() - t0) * 1000, 1)
            try:
                data = json.loads(body.decode("utf-8"))
            except ValueError as exc:
                _log(f"api:{endpoint}", "failed", draw_round=draw_round, error_code="json_parse", http=200, ms=ms, units=units)
                raise YTError("json_parse", "JSON 파싱 실패", 200) from exc
            _log(f"api:{endpoint}", "ok", draw_round=draw_round, http=200, ms=ms, items=len(data.get("items", [])),
                 units=units, error_code="backup_key" if i else None)
            return data
        except urllib.error.HTTPError as exc:
            ms = round((time.time() - t0) * 1000, 1)
            reason = ""
            try:
                err = json.loads(exc.read().decode("utf-8")).get("error") or {}
                reason = ((err.get("errors") or [{}])[0].get("reason") or "")
                for d in err.get("details") or []:
                    reason = d.get("reason") or reason
            except Exception:  # noqa: BLE001
                pass
            kind = _KIND.get(reason) or {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
                                         429: "rate_limited", 500: "server_error", 503: "unavailable"}.get(exc.code, "http_error")
            _log(f"api:{endpoint}", "failed", draw_round=draw_round, error_code=f"{kind}:{reason}", http=exc.code, ms=ms,
                 units=units if exc.code != 400 else 0)
            last = YTError(kind, f"HTTP {exc.code} {reason}", exc.code, reason)
            if kind in ("invalid_key", "quota_exceeded", "key_restriction", "api_disabled") and i + 1 < len(ks):
                continue  # 백업 키로 1회 전환
            raise last from exc
        except urllib.error.URLError as exc:
            ms = round((time.time() - t0) * 1000, 1)
            s = str(exc.reason)
            kind = "dns" if "Name or service" in s or "getaddrinfo" in s else "tls" if "SSL" in s or "CERTIFICATE" in s \
                else "connect_timeout" if "timed out" in s else "network"
            _log(f"api:{endpoint}", "failed", draw_round=draw_round, error_code=kind, error_message=s, ms=ms)
            raise YTError(kind, s) from exc
        except TimeoutError as exc:
            _log(f"api:{endpoint}", "failed", draw_round=draw_round, error_code="read_timeout", ms=round((time.time() - t0) * 1000, 1))
            raise YTError("read_timeout", "응답 대기 시간 초과") from exc
    assert last is not None
    raise last


def run_api_tests() -> Dict[str, Any]:
    """search / videos / channels / playlistItems 를 각각 독립 테스트(키 값 비노출)."""
    out: Dict[str, Any] = {"key_status": key_status(), "tested_at": db.now_iso(), "tests": {}}
    tests = [
        ("search", {"part": "snippet", "q": "1249회 로또 자동", "type": "video", "maxResults": 5, "regionCode": "KR"}),
        ("videos", {"part": "snippet,contentDetails,statistics,status", "id": "LSYXNhnsvtc"}),
        ("channels", {"part": "snippet,contentDetails", "id": "UCY4Q_k9uyV95AXKiAq_s0BA"}),
        ("playlistItems", {"part": "snippet", "playlistId": "UUY4Q_k9uyV95AXKiAq_s0BA", "maxResults": 5}),
    ]
    for ep, params in tests:
        t0 = time.time()
        try:
            data = call(ep, params)
            out["tests"][ep] = {"ok": True, "items": len(data.get("items", [])), "ms": round((time.time() - t0) * 1000, 1),
                                "has_next_page": bool(data.get("nextPageToken"))}
        except YTError as exc:
            out["tests"][ep] = {"ok": False, "kind": exc.kind, "http": exc.http, "reason": exc.reason,
                                "fix": _RECOVERY.get(exc.kind)}
    out["ok"] = all(t.get("ok") for t in out["tests"].values())
    first_fail = next((t for t in out["tests"].values() if not t.get("ok")), None)
    out["diagnosis"] = first_fail.get("kind") if first_fail else "ok"
    out["fix"] = first_fail.get("fix") if first_fail else None
    return out


# ─────────────────────────────── 작업 큐 ───────────────────────────────

def _draw_date(n: int) -> date:
    return date(2002, 12, 7) + timedelta(days=7 * (int(n) - 1))


def create_round_jobs(latest_round: int, *, templates: Optional[List[str]] = None) -> Dict[str, Any]:
    """1~latest 회차 × 검색어 + 회차 기간 검색(제목에 회차 없는 영상) 작업 생성(중복 없음).

    우선순위(작을수록 먼저): 최근 완료 회차 → 기준 영상 회차 → 과거 회차 순. 회차별 첫 검색어·기간 검색을 먼저
    모든 회차에 돌린 뒤 나머지 검색어로 넓힌다(할당량을 회차 전반에 고르게)."""
    templates = templates or QUERY_TEMPLATES
    now = db.now_iso()
    created = 0
    with db.transaction() as c:
        have = {r[0] for r in c.execute("SELECT job_id FROM youtube_search_jobs")}
        for n in range(int(latest_round), 0, -1):
            age = latest_round - n
            base = 0 if age < 4 else (1 if n == SEED_ROUND else 2)
            d = _draw_date(n)
            jobs: List[Tuple[str, str, Optional[str], Optional[str], int]] = []
            for ti, t in enumerate(templates):
                jobs.append((t.format(n=n), "round_query", None, None, base * 1_000_000 + ti * 10_000 + age))
            # 기간 검색: 추첨일 -7일 ~ +3일 업로드, 회차 번호 없는 검색어
            jobs.append(("로또 자동 용지", "period", (d - timedelta(days=7)).isoformat() + "T00:00:00Z",
                         (d + timedelta(days=3)).isoformat() + "T00:00:00Z", base * 1_000_000 + 5_000 + age))
            for q, st, pa, pb, pr in jobs:
                jid = hashlib.sha1(f"{n}|{q}|{st}|{pa}".encode()).hexdigest()[:20]
                if jid in have:
                    continue
                c.execute("INSERT INTO youtube_search_jobs (job_id,draw_round,search_query,search_type,published_after,"
                          "published_before,page_token,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (jid, n, q, st, pa, pb, None, pr, "queued", now, now))
                created += 1
        # 이번 회차(latest+1, 판매 중) — 최우선, 매일 다시 검색(주중에 새 영상이 계속 올라오므로 날짜별 작업 ID)
        cur = int(latest_round) + 1
        today = datetime.now(timezone.utc).date().isoformat()
        start = (_draw_date(latest_round) + timedelta(days=1)).isoformat() + "T00:00:00Z" if latest_round else None
        cur_jobs = [(t.format(n=cur), "round_query", None, None, -1_000_000 + ti) for ti, t in enumerate(CURRENT_TEMPLATES)]
        cur_jobs.append(("로또 자동 용지", "period", start, None, -1_000_000 + 900))
        cur_jobs.append(("로또 반자동 용지", "period", start, None, -1_000_000 + 901))
        for q, st, pa, pb, pr in cur_jobs:
            jid = hashlib.sha1(f"{cur}|{q}|{st}|{pa}|{today}".encode()).hexdigest()[:20]
            if jid in have:
                continue
            c.execute("INSERT INTO youtube_search_jobs (job_id,draw_round,search_query,search_type,published_after,"
                      "published_before,page_token,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (jid, cur, q, st, pa, pb, None, pr, "queued", now, now))
            created += 1
    return {"created": created, "rounds": latest_round, "current_round": int(latest_round) + 1,
            "templates": len(templates) + 1}


def _store_video(c, item: Dict[str, Any], via: str) -> bool:
    vid = (item.get("id") or {}).get("videoId") if isinstance(item.get("id"), dict) else item.get("id")
    sn = item.get("snippet") or {}
    if not vid:
        return False
    if c.execute("SELECT 1 FROM youtube_videos WHERE video_id = ?", (vid,)):
        c.execute("UPDATE youtube_videos SET last_checked_at = ? WHERE video_id = ?", (db.now_iso(), vid))
        return False
    c.execute("INSERT INTO youtube_videos (video_id,video_url,title,description,channel_id,channel_title,published_at,"
              "collection_status,first_collected_at,last_checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
              (vid, f"https://www.youtube.com/watch?v={vid}", sn.get("title"), (sn.get("description") or "")[:2000],
               sn.get("channelId"), sn.get("channelTitle"), sn.get("publishedAt"), "discovered", db.now_iso(), db.now_iso()))
    ch = sn.get("channelId")
    if ch:
        if not c.execute("SELECT 1 FROM youtube_channels WHERE channel_id = ?", (ch,)):
            c.execute("INSERT INTO youtube_channels (channel_id,channel_title,channel_url,discovery_source,first_discovered_at,"
                      "videos_found) VALUES (?,?,?,?,?,1)", (ch, sn.get("channelTitle"),
                      f"https://www.youtube.com/channel/{ch}", via, db.now_iso()))
        else:
            c.execute("UPDATE youtube_channels SET videos_found = videos_found + 1 WHERE channel_id = ?", (ch,))
    return True


def _map_rounds(c, vid: str, title: str, published_at: Optional[str], job_round: Optional[int], via: str) -> None:
    rounds = {int(m) for m in _ROUND_RE.findall(title or "") if 1 <= int(m) <= 5000}
    for r in rounds:
        c.execute("INSERT INTO youtube_video_rounds (video_id,draw_round,mapping_confidence,mapping_method,verification_status) "
                  "VALUES (?,?,?,?,?) ON CONFLICT (video_id, draw_round) DO NOTHING", (vid, r, 0.7, "title_round", "unverified"))
    if not rounds and job_round and published_at:
        # 제목에 회차가 없으면 게시일과 추첨일 근접성만으로 '후보'로만 연결(확정 아님)
        try:
            pd_ = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
            if -7 <= (pd_ - _draw_date(job_round)).days <= 3:
                c.execute("INSERT INTO youtube_video_rounds (video_id,draw_round,mapping_confidence,mapping_method,"
                          "verification_status) VALUES (?,?,?,?,?) ON CONFLICT (video_id, draw_round) DO NOTHING",
                          (vid, job_round, 0.2, "published_window", "candidate"))
        except ValueError:
            pass


def _enqueue_for_ocr(c, vid: str, title: str, ch_id: Optional[str], ch_title: Optional[str], published_at: Optional[str],
                     via: str) -> None:
    """용지 판독 큐(youtube_discovered_videos)에 연결 — 제목에 자동/반자동/용지 단서가 있을 때만."""
    if not re.search(r"자동|반자동|용지|구매|첫자동", title or ""):
        return
    if c.execute("SELECT 1 FROM youtube_discovered_videos WHERE video_id = ?", (vid,)):
        return
    m = _ROUND_RE.search(title or "")
    c.execute("INSERT INTO youtube_discovered_videos (video_id,source_seed_id,channel_id,channel_title,title,video_url,"
              "published_at,similarity_score,video_category,collection_status,round_hint,discovered_via,discovered_at) "
              "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (vid, "search", ch_id, ch_title, title, f"https://www.youtube.com/watch?v={vid}", published_at, 0.3, None,
               "queued", int(m.group(1)) if m else None, via, db.now_iso()))


def run_jobs(max_jobs: int = 40) -> Dict[str, Any]:
    """우선순위 순으로 검색 작업 실행 — 할당량 예산 내에서만. 실패해도 작업은 남고(재시도) 잃지 않는다."""
    out: Dict[str, Any] = {"ran": 0, "videos_new": 0, "errors": {}, "stopped": None}
    if not keys():
        n = db.query("SELECT COUNT(*) FROM youtube_search_jobs WHERE status = 'queued'")
        out["stopped"] = "missing_key"
        out["queued"] = int(n[0][0]) if n else 0
        return out
    rows = db.query("SELECT job_id, draw_round, search_query, search_type, published_after, published_before, page_token, "
                    "attempts FROM youtube_search_jobs WHERE status IN ('queued','retry') ORDER BY priority LIMIT "
                    + str(int(max_jobs)))
    for jid, rnd, q, st, pa, pb, tok, att in rows:
        try:
            data = call("search", {"part": "snippet", "q": q, "type": "video", "maxResults": 50, "regionCode": "KR",
                                   "relevanceLanguage": "ko", "publishedAfter": pa, "publishedBefore": pb,
                                   "pageToken": tok, "order": "date" if st == "period" else None}, draw_round=rnd)
        except YTError as exc:
            out["errors"][exc.kind] = out["errors"].get(exc.kind, 0) + 1
            fatal = exc.kind in ("missing_key", "invalid_key", "api_disabled", "key_restriction", "forbidden")
            stop = exc.kind in ("quota_exceeded", "quota_budget") or fatal
            with db.transaction() as c:
                c.execute("UPDATE youtube_search_jobs SET status=?, attempts=attempts+1, last_error=?, updated_at=? WHERE job_id=?",
                          ("queued" if stop else ("failed" if att + 1 >= 3 else "retry"), f"{exc.kind}:{exc.reason}",
                           db.now_iso(), jid))
            if stop:
                out["stopped"] = exc.kind
                out["fix"] = _RECOVERY.get(exc.kind)
                break
            continue
        items = data.get("items", [])
        new = 0
        with db.transaction() as c:
            for it in items:
                sn = it.get("snippet") or {}
                vid = (it.get("id") or {}).get("videoId")
                if not vid:
                    continue
                if _store_video(c, it, f"search:{st}"):
                    new += 1
                _map_rounds(c, vid, sn.get("title") or "", sn.get("publishedAt"), rnd, st)
                _enqueue_for_ocr(c, vid, sn.get("title") or "", sn.get("channelId"), sn.get("channelTitle"),
                                 sn.get("publishedAt"), f"search:{st}")
            nxt = data.get("nextPageToken")
            status = "done_results" if items else "done_no_results"
            c.execute("UPDATE youtube_search_jobs SET status=?, attempts=attempts+1, discovered_count=discovered_count+?, "
                      "result_count=?, page_token=?, last_error=NULL, updated_at=? WHERE job_id=?",
                      (status, new, len(items), nxt, db.now_iso(), jid))
            if nxt and new > 0:  # 새 영상이 나오는 동안만 다음 페이지(할당량 절약)
                pj = hashlib.sha1(f"{jid}|{nxt}".encode()).hexdigest()[:20]
                if not c.execute("SELECT 1 FROM youtube_search_jobs WHERE job_id = ?", (pj,)):
                    c.execute("INSERT INTO youtube_search_jobs (job_id,draw_round,search_query,search_type,published_after,"
                              "published_before,page_token,priority,status,created_at,updated_at) "
                              "SELECT ?,draw_round,search_query,search_type,published_after,published_before,?,priority+1,"
                              "'queued',?,? FROM youtube_search_jobs WHERE job_id = ?", (pj, nxt, db.now_iso(), db.now_iso(), jid))
        out["ran"] += 1
        out["videos_new"] += new
    out["quota_used_today"] = quota_used_today()
    return out


def enrich_videos(limit: int = 200) -> Dict[str, Any]:
    """videos.list 로 길이·조회수·공개상태(50개 단위, 1 unit) — 키 필요."""
    if not keys():
        return {"stopped": "missing_key"}
    rows = [r[0] for r in db.query("SELECT video_id FROM youtube_videos WHERE duration IS NULL LIMIT " + str(int(limit)))]
    done = 0
    for i in range(0, len(rows), 50):
        try:
            data = call("videos", {"part": "contentDetails,statistics,status", "id": ",".join(rows[i:i + 50])})
        except YTError as exc:
            return {"enriched": done, "stopped": exc.kind}
        got = set()
        with db.transaction() as c:
            for it in data.get("items", []):
                got.add(it["id"])
                c.execute("UPDATE youtube_videos SET duration=?, view_count=?, privacy_status=?, last_checked_at=? WHERE video_id=?",
                          ((it.get("contentDetails") or {}).get("duration"),
                           int((it.get("statistics") or {}).get("viewCount") or 0),
                           (it.get("status") or {}).get("privacyStatus"), db.now_iso(), it["id"]))
                done += 1
            for vid in set(rows[i:i + 50]) - got:  # 삭제·비공개 등으로 응답에 없음
                c.execute("UPDATE youtube_videos SET collection_status='unavailable', duration='n/a', last_checked_at=? "
                          "WHERE video_id=?", (db.now_iso(), vid))
    return {"enriched": done}


def scan_channels(limit: int = 20) -> Dict[str, Any]:
    """발견된 채널의 과거 업로드(키 있으면 playlistItems 전체 페이지, 없으면 RSS 최근 15개)."""
    from . import youtube

    rows = db.query("SELECT channel_id, channel_title FROM youtube_channels ORDER BY COALESCE(last_scanned_at,'') LIMIT "
                    + str(int(limit)))
    out = {"channels": 0, "videos_new": 0, "errors": []}
    for cid, title in rows:
        items: List[Dict[str, Any]] = []
        try:
            if keys():
                tok = None
                for _ in range(10):  # 채널당 최대 500개
                    data = call("playlistItems", {"part": "snippet", "playlistId": "UU" + cid[2:], "maxResults": 50,
                                                  "pageToken": tok})
                    for it in data.get("items", []):
                        sn = it.get("snippet") or {}
                        v = (sn.get("resourceId") or {}).get("videoId")
                        if v:
                            items.append({"id": {"videoId": v}, "snippet": {**sn, "channelId": cid}})
                    tok = data.get("nextPageToken")
                    if not tok:
                        break
            else:
                for v in youtube.fetch_channel_feed(cid, title or ""):
                    items.append({"id": {"videoId": v.video_id}, "snippet": {"title": v.title, "channelId": cid,
                                  "channelTitle": title, "publishedAt": v.published_at, "description": v.description}})
        except (YTError, youtube.YouTubeError) as exc:
            out["errors"].append({"channel": cid, "kind": getattr(exc, "kind", "error")})
            if getattr(exc, "kind", "") in ("quota_exceeded", "quota_budget"):
                break
        with db.transaction() as c:
            for it in items:
                sn = it["snippet"]
                vid = it["id"]["videoId"]
                if _store_video(c, it, "channel_scan"):
                    out["videos_new"] += 1
                _map_rounds(c, vid, sn.get("title") or "", sn.get("publishedAt"), None, "channel_scan")
                _enqueue_for_ocr(c, vid, sn.get("title") or "", cid, title, sn.get("publishedAt"), "channel_scan")
            c.execute("UPDATE youtube_channels SET last_scanned_at = ? WHERE channel_id = ?", (db.now_iso(), cid))
        out["channels"] += 1
    return out


def seed_known_channels() -> int:
    """이미 아는 채널(기준 영상·용지 채널·결과 채널)을 수집 채널 목록에 등록."""
    from . import tickets, youtube

    n = 0
    known = {"UCY4Q_k9uyV95AXKiAq_s0BA": "여보로또", **tickets.DEFAULT_TICKET_CHANNELS, **youtube.DEFAULT_CHANNELS}
    with db.transaction() as c:
        for cid, name in known.items():
            if not c.execute("SELECT 1 FROM youtube_channels WHERE channel_id = ?", (cid,)):
                c.execute("INSERT INTO youtube_channels (channel_id,channel_title,channel_url,discovery_source,"
                          "first_discovered_at) VALUES (?,?,?,?,?)", (cid, name, f"https://www.youtube.com/channel/{cid}",
                          "known", db.now_iso()))
                n += 1
    return n


def coverage() -> Dict[str, Any]:
    def one(sql: str, p: Tuple = ()) -> int:
        r = db.query(sql, p)
        return int(r[0][0] or 0) if r else 0

    latest = one("SELECT MAX(draw_round) FROM youtube_search_jobs")
    jobs = {r[0]: int(r[1]) for r in db.query("SELECT status, COUNT(*) FROM youtube_search_jobs GROUP BY status")}
    rounds_started = one("SELECT COUNT(DISTINCT draw_round) FROM youtube_search_jobs WHERE status LIKE 'done%'")
    rounds_all_done = one("SELECT COUNT(*) FROM (SELECT draw_round FROM youtube_search_jobs GROUP BY draw_round "
                          "HAVING SUM(CASE WHEN status LIKE 'done%' THEN 0 ELSE 1 END) = 0) t")
    rounds_with_video = one("SELECT COUNT(DISTINCT draw_round) FROM youtube_video_rounds")
    last_ok = db.query("SELECT MAX(created_at) FROM youtube_collection_logs WHERE operation LIKE 'api:%' AND status = 'ok'")
    last_err = db.query("SELECT created_at, operation, error_code, http_status, response_ms FROM youtube_collection_logs "
                        "WHERE operation LIKE 'api:%' AND status = 'failed' ORDER BY created_at DESC LIMIT 1")
    avg_ms = db.query("SELECT AVG(response_ms) FROM youtube_collection_logs WHERE operation LIKE 'api:%' AND status='ok'")
    unsearched = [int(r[0]) for r in db.query(
        "SELECT draw_round FROM youtube_search_jobs GROUP BY draw_round HAVING SUM(CASE WHEN status LIKE 'done%' THEN 1 ELSE 0 END) = 0 "
        "ORDER BY draw_round DESC LIMIT 20")]
    total_units_needed = (jobs.get("queued", 0) + jobs.get("retry", 0)) * UNITS["search"]
    return {
        "api": {"key_status": key_status(), "last_ok_call": last_ok[0][0] if last_ok else None,
                "last_error": (dict(zip(["at", "operation", "error_code", "http", "ms"], last_err[0])) if last_err else None),
                "avg_response_ms": round(float(avg_ms[0][0]), 1) if avg_ms and avg_ms[0][0] else None,
                "quota_used_today": quota_used_today(), "quota_budget": quota_budget()},
        "rounds": {"total": latest, "searched_any": rounds_started, "fully_searched": rounds_all_done,
                   "pending": max(0, latest - rounds_started), "with_videos": rounds_with_video,
                   "without_videos_after_search": max(0, rounds_started - rounds_with_video),
                   "recent_unsearched_sample": unsearched},
        "jobs": jobs,
        "estimated_days_remaining": round(total_units_needed / max(1, quota_budget()), 1),
        "videos": {"unique": one("SELECT COUNT(*) FROM youtube_videos"),
                   "unavailable": one("SELECT COUNT(*) FROM youtube_videos WHERE collection_status='unavailable'"),
                   "round_links": one("SELECT COUNT(*) FROM youtube_video_rounds"),
                   "queued_for_ticket_ocr": one("SELECT COUNT(*) FROM youtube_discovered_videos WHERE collection_status='queued'"),
                   "ocr_processed": one("SELECT COUNT(*) FROM youtube_discovered_videos WHERE collection_status='processed'")},
        "channels": {"total": one("SELECT COUNT(*) FROM youtube_channels"),
                     "scanned": one("SELECT COUNT(*) FROM youtube_channels WHERE last_scanned_at IS NOT NULL")},
        "honesty": "검색 API 는 모든 공개 영상을 보장하지 않습니다 — '검색 완료' 회차도 전수 확보를 뜻하지 않습니다.",
    }


def daily(max_jobs: Optional[int] = None) -> Dict[str, Any]:
    """정기: 채널 등록 → 회차 작업 보충 → (키 있으면) 검색·메타데이터 → 채널 스캔 → OCR 큐는 seeds 가 처리."""
    from ..stats_engine.draws import load_draws

    draws = load_draws()
    latest = draws[-1].round if draws else 0
    out = {"channels_seeded": seed_known_channels(), "jobs": create_round_jobs(latest)}
    out["search"] = run_jobs(max_jobs or int(_clean(os.environ.get("YOUTUBE_JOBS_PER_RUN")) or 80))
    out["enrich"] = enrich_videos()
    out["channels"] = scan_channels()
    out["coverage"] = coverage()
    return out


def connectivity_probe() -> Dict[str, Any]:
    """키 없이 googleapis 에 접속 — 403 'unregistered callers' 면 네트워크·DNS·TLS 는 정상이고 키만 없는 것."""
    t0 = time.time()
    try:
        urllib.request.urlopen(API + "videos?part=id&id=LSYXNhnsvtc", timeout=15)
        return {"reachable": True, "http": 200, "ms": round((time.time() - t0) * 1000, 1)}
    except urllib.error.HTTPError as exc:
        reason = ""
        try:
            reason = ((json.loads(exc.read().decode("utf-8")).get("error") or {}).get("errors") or [{}])[0].get("reason", "")
        except Exception:  # noqa: BLE001
            pass
        return {"reachable": True, "http": exc.code, "reason": reason, "ms": round((time.time() - t0) * 1000, 1),
                "meaning": "Google API 서버까지 도달(네트워크·DNS·TLS 정상). 키 없는 호출이라 거부됨." if exc.code == 403 else None}
    except Exception as exc:  # noqa: BLE001
        return {"reachable": False, "error": str(exc)[:200], "ms": round((time.time() - t0) * 1000, 1)}


def diagnose() -> Dict[str, Any]:
    out = {"key_status": key_status(), "network": connectivity_probe()}
    if keys():
        out["api_tests"] = run_api_tests()
        out["diagnosis"] = out["api_tests"]["diagnosis"]
        out["fix"] = out["api_tests"]["fix"]
    else:
        out["diagnosis"] = "missing_key"
        out["fix"] = _RECOVERY["missing_key"]
    return out


def round_detail(n: int) -> Dict[str, Any]:
    vids = db.query("SELECT v.video_id, v.title, v.channel_title, v.published_at, r.mapping_method, r.mapping_confidence, "
                    "r.verification_status FROM youtube_video_rounds r JOIN youtube_videos v ON v.video_id = r.video_id "
                    "WHERE r.draw_round = ? ORDER BY r.mapping_confidence DESC", (int(n),))
    seed_vids = db.query("SELECT video_id, title, channel_title, video_category FROM youtube_discovered_videos WHERE round_hint = ?",
                         (int(n),))
    tickets = []
    for table, ptype in (("ticket_auto_data", "auto"), ("ticket_semi_auto_data", "semi_auto")):
        for r in db.query(f"SELECT video_id, game_index, numbers, confidence, verification_status, round_status FROM {table} "
                          "WHERE draw_round = ?", (int(n),)):
            tickets.append({"pick_type": ptype, "video_id": r[0], "game": r[1], "numbers": db.loads(r[2]),
                            "ocr_confidence": r[3], "status": r[4], "round_status": r[5]})
    jobs = {r[0]: int(r[1]) for r in db.query("SELECT status, COUNT(*) FROM youtube_search_jobs WHERE draw_round = ? GROUP BY status",
                                              (int(n),))}
    return {"round": int(n), "search_jobs": jobs,
            "videos_found": [dict(zip(["video_id", "title", "channel", "published_at", "method", "confidence", "status"], v)) for v in vids],
            "ticket_videos": [dict(zip(["video_id", "title", "channel", "category"], v)) for v in seed_vids],
            "tickets_extracted": tickets,
            "note": "videos_found = 실제 발견한 영상 / tickets_extracted = 썸네일에서 실제 판독한 용지(관찰 데이터)."}
