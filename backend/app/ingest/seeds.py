"""기준(Seed) 영상 → 유사 용지 영상 자동 탐색 → 공개 썸네일 용지 판독 → 자동/반자동 DB → 학습 연결.

기준 영상(기본): https://www.youtube.com/watch?v=LSYXNhnsvtc
  "1249자동 2부방송 깨끗한용지입니다" · 채널 여보로또(@honeylotto, UCY4Q_k9uyV95AXKiAq_s0BA)
  — 2026-11-10 확인: maxres 썸네일에 1249회 출력 용지 A~E 5게임 전체가 '자 동' 라벨과 함께 보인다.

접근 경로(허용된 방식만)
- 메타데이터: oEmbed(키 불필요, 제목·채널) / 채널 RSS(최근 15개) / YouTube Data API(YOUTUBE_API_KEY 있을 때:
  videos.list 로 게시일·길이·공개상태, 채널 업로드 재생목록으로 과거 영상 전체, search.list).
- 화면: YouTube 가 공개 제공하는 썸네일 이미지만. 영상 스트림 다운로드·프레임 추출은 약관상 하지 않는다
  → youtube_video_frames.frame_source = 'thumbnail:maxres' (timestamp 없음).

분류(video_category)
  A same_video   : 같은 video_id(다른 URL 형태 포함) — 재등록 차단
  B reupload     : 다른 video_id 이지만 썸네일 해시가 거의 같거나 같은 용지 줄 집합
  C same_format  : 썸네일에서 출력 용지 줄(오름차순 6개)이 판독됨
  D low_relevance: 용지가 안 보이거나 번호를 확인할 수 없음/로또 무관 → 용지 DB 에 넣지 않음
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import db

DEFAULT_SEED = "LSYXNhnsvtc"
ALGORITHM_VERSION = "thumb-grid-1.0"
_VID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")
_ROUND_IN_TITLE = re.compile(r"(?<![\d/])(\d{3,4})\s*(?:회)?\s*(?:자동|반자동|수동|회)")
FIRST_DRAW = (2002, 12, 7)


def video_id_from(url_or_id: str) -> str:
    s = (url_or_id or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    m = _VID_RE.search(s)
    if not m:
        raise ValueError(f"YouTube 영상 ID 를 찾을 수 없음: {s[:80]}")
    return m.group(1)


def _get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; lotto-analyzer/1.0)",
                                               "Accept-Language": "ko-KR,ko;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def oembed(video_id: str) -> Dict[str, Any]:
    u = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(f"https://www.youtube.com/watch?v={video_id}")
    return json.loads(_get(u).decode("utf-8"))


def resolve_channel_id(author_url: str) -> Optional[str]:
    """@핸들 → 채널 ID. API 키가 있으면 channels.list(forHandle), 없으면 공개 채널 페이지의 externalId."""
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    handle = author_url.rstrip("/").split("/")[-1]
    if key and handle.startswith("@"):
        try:
            j = json.loads(_get("https://www.googleapis.com/youtube/v3/channels?" + urllib.parse.urlencode(
                {"part": "id", "forHandle": handle, "key": key})).decode("utf-8"))
            items = j.get("items") or []
            if items:
                return items[0]["id"]
        except Exception:  # noqa: BLE001
            pass
    if "/channel/" in author_url:
        return author_url.rstrip("/").split("/")[-1]
    try:
        html = _get(author_url).decode("utf-8", errors="replace")
        m = re.search(r'"externalId":"(UC[\w-]{22})"', html) or re.search(r'"channelId":"(UC[\w-]{22})"', html)
        return m.group(1) if m else None
    except Exception:  # noqa: BLE001
        return None


def api_video_details(video_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """videos.list — 게시일·길이·공개상태(키 필요). 키 없으면 {}."""
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key or not video_ids:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for i in range(0, len(video_ids), 50):
        j = json.loads(_get("https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(
            {"part": "snippet,contentDetails,status", "id": ",".join(video_ids[i:i + 50]), "key": key})).decode("utf-8"))
        for it in j.get("items", []):
            sn, cd, stt = it.get("snippet", {}), it.get("contentDetails", {}), it.get("status", {})
            out[it["id"]] = {"title": sn.get("title"), "description": sn.get("description"),
                             "published_at": sn.get("publishedAt"), "channel_id": sn.get("channelId"),
                             "channel_title": sn.get("channelTitle"), "duration": cd.get("duration"),
                             "privacy": stt.get("privacyStatus")}
    return out


def api_channel_uploads(channel_id: str, max_items: int = 200) -> List[Dict[str, Any]]:
    """채널 업로드 재생목록 전체(과거 영상) — 키 필요. 업로드 재생목록 ID = 'UU' + 채널 ID[2:]."""
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        return []
    pl = "UU" + channel_id[2:]
    out, token = [], None
    while len(out) < max_items:
        params = {"part": "snippet", "playlistId": pl, "maxResults": "50", "key": key}
        if token:
            params["pageToken"] = token
        j = json.loads(_get("https://www.googleapis.com/youtube/v3/playlistItems?" + urllib.parse.urlencode(params)).decode("utf-8"))
        for it in j.get("items", []):
            sn = it.get("snippet", {})
            vid = (sn.get("resourceId") or {}).get("videoId")
            if vid:
                out.append({"video_id": vid, "title": sn.get("title"), "published_at": sn.get("publishedAt"),
                            "channel_id": channel_id, "channel_title": sn.get("channelTitle")})
        token = j.get("nextPageToken")
        if not token:
            break
    return out[:max_items]


# ─────────────────────────────── 이미지 ───────────────────────────────

def fetch_thumbnail(video_id: str, dest: Path) -> Tuple[Optional[Path], str]:
    for q in ("maxresdefault", "sddefault", "hqdefault"):
        try:
            data = _get(f"https://i.ytimg.com/vi/{video_id}/{q}.jpg")
        except Exception:  # noqa: BLE001
            continue
        if len(data) < 2000:
            continue
        p = dest / f"{video_id}_{q}.jpg"
        p.write_bytes(data)
        return p, f"thumbnail:{q}"
    return None, "thumbnail:none"


def dhash(path: Path) -> str:
    """64비트 차분 해시 — 재업로드(같은 화면) 판별용."""
    import cv2
    import numpy as np

    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    small = cv2.resize(img, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    return "%016x" % int("".join("1" if b else "0" for b in bits), 2)


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def draw_date(round_no: int) -> str:
    from datetime import date, timedelta

    return (date(*FIRST_DRAW) + timedelta(days=7 * (int(round_no) - 1))).isoformat()


# ─────────────────────────────── 등록·탐색 ───────────────────────────────

def register_seed(url_or_id: str = DEFAULT_SEED) -> Dict[str, Any]:
    vid = video_id_from(url_or_id)
    existing = db.query("SELECT seed_id, analysis_status FROM youtube_seed_videos WHERE video_id = ?", (vid,))
    meta: Dict[str, Any] = {}
    errors = []
    try:
        oe = oembed(vid)
        meta.update(title=oe.get("title"), channel_title=oe.get("author_name"), author_url=oe.get("author_url"))
    except Exception as exc:  # noqa: BLE001
        errors.append({"stage": "oembed", "error": str(exc)[:200]})
    if meta.get("author_url"):
        meta["channel_id"] = resolve_channel_id(meta["author_url"])
    try:
        meta.update({k: v for k, v in (api_video_details([vid]).get(vid) or {}).items() if v})
    except Exception as exc:  # noqa: BLE001
        errors.append({"stage": "videos.list", "error": str(exc)[:200]})
    if not meta.get("title"):
        status = "failed_unreachable"
    else:
        status = "registered"
    seed_id = existing[0][0] if existing else "seed-" + vid
    with db.transaction() as c:
        c.execute(
            "INSERT INTO youtube_seed_videos (seed_id,video_id,video_url,title,channel_id,channel_title,published_at,"
            "analysis_status,analysis_json,registered_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (video_id) DO UPDATE SET "
            "title=excluded.title, channel_id=excluded.channel_id, channel_title=excluded.channel_title, "
            "published_at=COALESCE(excluded.published_at, youtube_seed_videos.published_at)",
            (seed_id, vid, f"https://www.youtube.com/watch?v={vid}", meta.get("title"), meta.get("channel_id"),
             meta.get("channel_title"), meta.get("published_at"), status, db.dumps({"meta": meta, "errors": errors}),
             db.now_iso()),
        )
    # 기준 영상 자신도 처리 대상(분석)으로 등록
    _upsert_discovered(vid, seed_id, meta, via="seed", similarity=1.0)
    return {"seed_id": seed_id, "video_id": vid, "status": status, "meta": meta, "errors": errors,
            "already_registered": bool(existing)}


def seed_features(title: str) -> Dict[str, Any]:
    t = title or ""
    return {"pick_words": [w for w in ("반자동", "자동", "수동") if w in t],
            "ticket_words": [w for w in ("용지", "깨끗한", "1부", "2부", "방송", "타") if w in t]}


def similarity(seed: Dict[str, Any], cand: Dict[str, Any], ticket_detected: Optional[bool] = None) -> float:
    s = 0.0
    if cand.get("channel_id") and cand.get("channel_id") == seed.get("channel_id"):
        s += 0.4
    sf, cf = seed_features(seed.get("title", "")), seed_features(cand.get("title", ""))
    if set(sf["pick_words"]) & set(cf["pick_words"]):
        s += 0.2
    if _ROUND_IN_TITLE.search(cand.get("title") or ""):
        s += 0.1
    if set(sf["ticket_words"]) & set(cf["ticket_words"]):
        s += 0.1
    if ticket_detected:
        s += 0.2
    return round(min(1.0, s), 3)


def _round_hint(title: str) -> Optional[int]:
    m = _ROUND_IN_TITLE.search(title or "")
    return int(m.group(1)) if m else None


def _upsert_discovered(vid: str, seed_id: str, meta: Dict[str, Any], *, via: str, similarity: float) -> bool:
    """새로 등록되면 True(동일 영상 재등록은 False → 카테고리 A 처리)."""
    with db.transaction() as c:
        ex = c.execute("SELECT video_id FROM youtube_discovered_videos WHERE video_id = ?", (vid,))
        if ex:
            return False
        c.execute(
            "INSERT INTO youtube_discovered_videos (video_id,source_seed_id,channel_id,channel_title,title,video_url,"
            "published_at,similarity_score,video_category,collection_status,round_hint,discovered_via,discovered_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (vid, seed_id, meta.get("channel_id"), meta.get("channel_title"), meta.get("title"),
             f"https://www.youtube.com/watch?v={vid}", meta.get("published_at"), similarity, None, "queued",
             _round_hint(meta.get("title") or ""), via, db.now_iso()),
        )
    return True


def discover(seed_video_id: str = DEFAULT_SEED, *, include_ticket_channels: bool = True) -> Dict[str, Any]:
    """기준 영상 채널(RSS/API 업로드 전체) + 같은 형식 채널 + (키 있으면) 검색어 → youtube_discovered_videos."""
    from . import tickets, youtube

    rows = db.query("SELECT seed_id, title, channel_id, channel_title FROM youtube_seed_videos WHERE video_id = ?",
                    (seed_video_id,))
    if not rows:
        reg = register_seed(seed_video_id)
        rows = [(reg["seed_id"], reg["meta"].get("title"), reg["meta"].get("channel_id"), reg["meta"].get("channel_title"))]
    seed_id, s_title, s_ch, s_chname = rows[0]
    seed = {"title": s_title or "", "channel_id": s_ch}
    found: Dict[str, Dict[str, Any]] = {}
    errors: List[Dict[str, Any]] = []
    channels = {s_ch: s_chname} if s_ch else {}
    if include_ticket_channels:
        channels.update({k: v for k, v in tickets.DEFAULT_TICKET_CHANNELS.items() if k not in channels})
    for cid, name in channels.items():
        try:
            for v in youtube.fetch_channel_feed(cid, name):
                found.setdefault(v.video_id, {"video_id": v.video_id, "title": v.title, "channel_id": v.channel_id or cid,
                                              "channel_title": name, "published_at": v.published_at, "via": "rss"})
        except youtube.YouTubeError as exc:
            errors.append({"source": f"rss:{cid}", "kind": exc.kind, "error": str(exc)[:200]})
        try:
            for v in api_channel_uploads(cid):
                found.setdefault(v["video_id"], {**v, "via": "api_uploads"})
        except Exception as exc:  # noqa: BLE001
            errors.append({"source": f"api_uploads:{cid}", "kind": "api_error", "error": str(exc)[:200]})
    # 검색어 — 기준 영상 제목·채널에서 생성(API 키 있을 때만)
    queries = []
    rh = _round_hint(s_title or "")
    if rh:
        queries += [f"{rh}자동 용지", f"로또 {rh}회 자동 용지", f"로또 {rh}회 반자동"]
    queries += ["로또 자동 용지 공유", "로또 반자동 용지", "로또 첫자동 용지"]
    for q in queries:
        try:
            for v in youtube.api_search(q, max_results=15):
                found.setdefault(v.video_id, {"video_id": v.video_id, "title": v.title, "channel_id": v.channel_id,
                                              "channel_title": v.channel_title, "published_at": v.published_at,
                                              "via": f"search:{q}"})
        except youtube.YouTubeError as exc:
            errors.append({"source": "api_search", "kind": exc.kind, "error": str(exc)[:200]})
            break
    new = dup = 0
    for vid, meta in found.items():
        if _upsert_discovered(vid, seed_id, meta, via=meta["via"], similarity=similarity(seed, meta)):
            new += 1
        else:
            dup += 1
    return {"seed_id": seed_id, "candidates": len(found), "new": new, "already_known": dup,
            "channels": list(channels.values()), "queries": queries if not any(e["kind"] == "no_api_key" for e in errors) else [],
            "errors": errors, "api_key": bool(os.environ.get("YOUTUBE_API_KEY"))}


# ─────────────────────────────── 처리(용지 판독) ───────────────────────────────

def _store_typed(c, vid: str, frame_id: str, line: Dict[str, Any], rnd: Optional[int], round_status: str,
                 status: str) -> Optional[str]:
    ptype = line["pick_type"]
    if ptype not in ("auto", "semi_auto") or status in ("rejected_shape", "excluded_manual"):
        return None
    tid = hashlib.sha1(f"{vid}|{line.get('column')}|{line.get('game_label')}|{line['numbers']}".encode()).hexdigest()[:20]
    table = "ticket_auto_data" if ptype == "auto" else "ticket_semi_auto_data"
    if c.execute(f"SELECT ticket_id FROM {table} WHERE ticket_id = ?", (tid,)):
        return None
    if ptype == "auto":
        c.execute("INSERT INTO ticket_auto_data (ticket_id,video_id,frame_id,draw_round,round_status,game_index,numbers,"
                  "confidence,type_confidence,verification_status,observed_only,algorithm_version,created_at) "
                  "VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
                  (tid, vid, frame_id, rnd, round_status, line.get("game_label"), db.dumps(line["numbers"]),
                   line["ocr_confidence"], line["type_confidence"], status, ALGORITHM_VERSION, db.now_iso()))
    else:
        # 출력 용지에는 반자동 줄에서 사람이 직접 고른 번호가 구분 표시되지 않는다 → selected/generated 미상
        c.execute("INSERT INTO ticket_semi_auto_data (ticket_id,video_id,frame_id,draw_round,round_status,game_index,"
                  "selected_numbers,generated_numbers,numbers,confidence,type_confidence,verification_status,"
                  "observed_only,algorithm_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
                  (tid, vid, frame_id, rnd, round_status, line.get("game_label"), None, None, db.dumps(line["numbers"]),
                   line["ocr_confidence"], line["type_confidence"], status, ALGORITHM_VERSION, db.now_iso()))
    return tid


def process_video(vid: str, title: str = "", round_hint: Optional[int] = None) -> Dict[str, Any]:
    """썸네일 1장 판독 → 프레임·용지 DB. 카테고리 B/C/D 판정."""
    from . import tickets

    with tempfile.TemporaryDirectory() as td:
        img, source = fetch_thumbnail(vid, Path(td))
        if img is None:
            return {"video_id": vid, "category": "D_low_relevance", "status": "no_thumbnail"}
        fh = dhash(img)
        res = tickets.extract_ticket_lines(img, title)
        img.unlink(missing_ok=True)  # 이미지 비보관(식별정보 포함 가능)
    valid = [ln for ln in res.get("lines", []) if ln["valid_shape"]]
    ticket_round = res.get("round")
    # 회차 확인: 용지에 찍힌 '제 N 회' 를 우선, 제목 회차와 다르면 미확정
    if ticket_round and round_hint and ticket_round != round_hint:
        rnd, round_status = ticket_round, "conflict_title_vs_ticket"
    elif ticket_round:
        rnd, round_status = ticket_round, "ticket_printed"
    elif round_hint:
        rnd, round_status = round_hint, "title_only_unconfirmed"
    else:
        rnd, round_status = None, "unknown"
    # 재업로드(B): 기존 프레임과 해시 거의 동일
    # 재업로드는 '용지가 보이는' 같은 화면일 때만 — 매주 같은 썸네일 템플릿(용지 없음)을 쓰는 채널은
    # 해시가 비슷해도 재업로드가 아니다(실측: 로또119 14개 오판 → 수정).
    others = db.query("SELECT video_id, frame_hash FROM youtube_video_frames WHERE video_id <> ? AND ticket_detected = 1",
                      (vid,))
    dup_of = next((o[0] for o in others if hamming(o[1], fh) <= 5), None) if valid else None
    if dup_of:
        category = "B_reupload"
    elif valid:
        category = "C_same_format"
    else:
        category = "D_low_relevance"
    counts: Dict[str, int] = {}
    frame_id = f"{vid}:{source}"
    with db.transaction() as c:
        c.execute("DELETE FROM youtube_video_frames WHERE frame_id = ?", (frame_id,))  # 알고리즘 재처리 시 교체
        c.execute("INSERT INTO youtube_video_frames (frame_id,video_id,timestamp,frame_source,frame_hash,ticket_detected,"
                  "extraction_status,ticket_round,lines_found,algorithm_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (frame_id, vid, None, source, fh, int(bool(valid)),
                   "ok" if valid else ("no_ticket" if not res.get("lines") else "unreadable"),
                   ticket_round, len(valid), ALGORITHM_VERSION, db.now_iso()))
        if category == "C_same_format":
            for ln in res["lines"]:
                st = tickets.classify_line(ln, rnd if round_status != "unknown" else None)
                if round_status in ("conflict_title_vs_ticket", "title_only_unconfirmed") and st == "accepted":
                    st = "pending_review"  # 회차 미확정이면 확정 데이터로 쓰지 않음
                counts[st] = counts.get(st, 0) + 1
                _store_typed(c, vid, frame_id, ln, rnd, round_status, st)
        c.execute("UPDATE youtube_discovered_videos SET video_category=?, duplicate_group_id=?, collection_status=?, "
                  "processed_at=?, algorithm_version=?, similarity_score=CASE WHEN COALESCE(similarity_score,0) > ? "
                  "THEN COALESCE(similarity_score,0) ELSE ? END "
                  "WHERE video_id=?",
                  (category, dup_of, "processed", db.now_iso(), ALGORITHM_VERSION, 0.2 if valid else 0.0,
                   0.2 if valid else 0.0, vid))
    # 기존 reg_tickets 경로에도 기록(이전 분석 API 호환)
    if category == "C_same_format":
        tickets.store_lines({"video_id": vid, "url": f"https://www.youtube.com/watch?v={vid}", "round_hint": rnd},
                            {"round": rnd, "lines": res["lines"]})
    return {"video_id": vid, "category": category, "round": rnd, "round_status": round_status,
            "lines": len(res.get("lines", [])), "valid_lines": len(valid), "counts": counts, "duplicate_of": dup_of}


def process_queue(limit: int = 10) -> Dict[str, Any]:
    """미처리(또는 알고리즘 버전이 바뀐) 영상만 처리 — 이미 분석한 영상은 재처리하지 않는다."""
    rows = db.query("SELECT video_id, title, round_hint FROM youtube_discovered_videos WHERE collection_status IN ('queued','failed') "
                    "OR (collection_status = 'processed' AND COALESCE(algorithm_version,'') <> ?) "
                    "ORDER BY CASE WHEN discovered_via = 'seed' THEN 0 ELSE 1 END, similarity_score DESC, published_at DESC "
                    "LIMIT " + str(int(limit)), (ALGORITHM_VERSION,))
    out = {"processed": 0, "by_category": {}, "videos": [], "errors": []}
    for vid, title, rh in rows:
        try:
            r = process_video(vid, title or "", rh)
        except Exception as exc:  # noqa: BLE001
            with db.transaction() as c:
                c.execute("UPDATE youtube_discovered_videos SET collection_status='failed', error=? WHERE video_id=?",
                          (str(exc)[:300], vid))
            out["errors"].append({"video_id": vid, "error": str(exc)[:200]})
            continue
        out["processed"] += 1
        out["by_category"][r["category"]] = out["by_category"].get(r["category"], 0) + 1
        out["videos"].append(r)
    return out


# ─────────────────────────────── 학습 연결 ───────────────────────────────

# 2026-11-10: 6종 엔진 모두 video_analysis.ticket_source 를 통해 유튜브 확정 용지를 입력으로 읽는다
# (TICKET_LEARNING_SOURCE=youtube 기본). 아래 nested_cv/shap_drift 는 자동·반자동을 '분리'한 추가 실행.
LEARNING_LINK = {
    "feature_learning": "connected",
    "nested_cv": "connected",
    "shap_drift": "connected",
    "pattern_mining": "connected",
    "round_learning": "connected",
    "overlap_learning": "connected",
}


def youtube_round_samples(pick_type: str) -> List[Any]:
    """확정(accepted) 유튜브 용지 → 엔진 표본(RoundSample). 자동/반자동은 섞지 않고 각각 만든다."""
    from ..stats_engine.draws import load_draws
    from ..video_analysis.feature_learning_engine import RoundSample, build_number_features

    table = "ticket_auto_data" if pick_type == "auto" else "ticket_semi_auto_data"
    rows = db.query(f"SELECT draw_round, numbers FROM {table} WHERE verification_status = 'accepted' "
                    "AND round_status = 'ticket_printed'")
    win = {d.round: list(d.numbers) for d in load_draws()}
    by_round: Dict[int, List[List[int]]] = {}
    for rnd, nums in rows:
        if rnd in win:  # 추첨 완료 회차만(미래 회차는 정답 없음)
            by_round.setdefault(int(rnd), []).append(db.loads(nums))
    samples = []
    for rnd, lines in sorted(by_round.items()):
        auto = lines if pick_type == "auto" else []
        semi = lines if pick_type == "semi_auto" else []
        samples.append(RoundSample(round_no=rnd, auto_lines=auto, semi_lines=semi, winning=win[rnd],
                                   features=build_number_features(auto, semi)))
    return samples


def run_learning() -> Dict[str, Any]:
    """유튜브 확정 용지로 6종 엔진 본 실행(ticket_source 경유) + 자동/반자동 분리 실행. 결과를 이력에 기록."""
    from ..video_analysis.nested_cv import run_nested_feature_cv
    from ..video_analysis.shap_drift_stub import build_shap_drift_report

    out: Dict[str, Any] = {}
    # 1) 6종 엔진 본 실행(자동+반자동, ticket_source 경유) — 입력이 바뀐 경우에만 재학습(jobs 쪽 시그니처 비교)
    try:
        from . import jobs as _jobs

        main = _jobs.learning_engines()
        out["engines"] = {k: v for k, v in main.items() if k not in ("input_rounds",)}
        with db.transaction() as c:
            for eng in LEARNING_LINK:
                c.execute("INSERT INTO ticket_learning_history (learning_id,video_id,ticket_id,engine_id,algorithm_version,"
                          "learning_status,pick_type,draw_round,sample_count,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (uuid.uuid4().hex, None, None, eng, ALGORITHM_VERSION, str(main.get(eng)), "auto+semi_auto",
                           (main.get("input_rounds") or [None])[-1], main.get("input_samples"), db.dumps({"result": main.get(eng)}),
                           db.now_iso()))
    except Exception as exc:  # noqa: BLE001
        out["engines"] = {"error": str(exc)[:300]}
    # 2) 자동/반자동 분리 실행(표본을 직접 받는 엔진)
    runners = {"nested_cv": lambda s: run_nested_feature_cv(s, seed=42),
               "shap_drift": lambda s: build_shap_drift_report(s, seed=42)}
    for ptype in ("auto", "semi_auto"):
        samples = youtube_round_samples(ptype)
        for eng in ("nested_cv", "shap_drift"):
            key = f"{eng}:{ptype}"
            if len(samples) < 3:
                status, result = "insufficient_data", {"samples": len(samples), "reason": "추첨 완료 회차의 확정 용지 회차 3개 미만"}
            else:
                try:
                    r = runners[eng](samples)
                    # 엔진이 스스로 표본 부족 등으로 ok=false 를 내면 '완료'로 기록하지 않는다
                    status = "completed" if (not isinstance(r, dict) or r.get("ok", True)) else "insufficient_data_engine"
                    result = {k: r.get(k) for k in ("ok", "scoring_allowed", "verdict", "n_outer", "reason")
                              if isinstance(r, dict) and k in r and not isinstance(r.get(k), (list, dict))}
                    result["samples"] = len(samples)
                except Exception as exc:  # noqa: BLE001
                    status, result = "failed", {"error": str(exc)[:300]}
            with db.transaction() as c:
                c.execute("INSERT INTO ticket_learning_history (learning_id,video_id,ticket_id,engine_id,algorithm_version,"
                          "learning_status,pick_type,draw_round,sample_count,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (uuid.uuid4().hex, None, None, eng, ALGORITHM_VERSION, status, ptype,
                           samples[-1].round_no if samples else None, len(samples), db.dumps(result), db.now_iso()))
            out[key] = status
    return out


def daily() -> Dict[str, Any]:
    reg = register_seed(DEFAULT_SEED)
    # 전 회차 검색(키 있을 때)·채널 스캔 → 용지 단서 있는 영상은 판독 큐에 들어온다
    try:
        from . import yt_collect

        collect = yt_collect.daily()
    except Exception as exc:  # noqa: BLE001
        collect = {"error": str(exc)[:300]}
    disc = discover(DEFAULT_SEED)
    proc = process_queue(limit=int(os.environ.get("TICKET_SCAN_LIMIT", "10")))
    learn = run_learning() if proc["processed"] else {"skipped": "신규 처리 영상 없음"}
    return {"seed": reg["status"], "collect": {k: collect.get(k) for k in ("search", "enrich", "channels")}
            if isinstance(collect, dict) else collect, "discover": disc, "process": proc, "learning": learn}


def dashboard() -> Dict[str, Any]:
    def one(sql: str, params: Tuple = ()) -> int:
        r = db.query(sql, params)
        return int(r[0][0] or 0) if r else 0

    seeds = db.query("SELECT video_id, title, channel_title, analysis_status, registered_at FROM youtube_seed_videos")
    cats = {r[0] or "unprocessed": int(r[1]) for r in db.query(
        "SELECT video_category, COUNT(*) FROM youtube_discovered_videos GROUP BY video_category")}
    auto_st = {r[0]: int(r[1]) for r in db.query("SELECT verification_status, COUNT(*) FROM ticket_auto_data GROUP BY verification_status")}
    semi_st = {r[0]: int(r[1]) for r in db.query("SELECT verification_status, COUNT(*) FROM ticket_semi_auto_data GROUP BY verification_status")}
    by_channel = [{"channel": r[0], "auto_accepted": int(r[1])} for r in db.query(
        "SELECT d.channel_title, COUNT(*) FROM ticket_auto_data t JOIN youtube_discovered_videos d ON d.video_id = t.video_id "
        "WHERE t.verification_status = 'accepted' GROUP BY d.channel_title ORDER BY 2 DESC")]
    total_acc = sum(x["auto_accepted"] for x in by_channel)
    learning = [{"engine": r[0], "pick_type": r[1], "status": r[2], "samples": r[3], "at": r[4]} for r in db.query(
        "SELECT engine_id, pick_type, learning_status, sample_count, MAX(created_at) FROM ticket_learning_history "
        "GROUP BY engine_id, pick_type, learning_status, sample_count ORDER BY 5 DESC LIMIT 24")]
    return {
        "seeds": [{"video_id": s[0], "title": s[1], "channel": s[2], "status": s[3], "registered_at": s[4]} for s in seeds],
        "discovered_total": sum(cats.values()),
        "by_category": cats,
        "similar_found": cats.get("C_same_format", 0),
        "duplicates_removed": cats.get("B_reupload", 0),
        "frames_with_ticket": one("SELECT COUNT(*) FROM youtube_video_frames WHERE ticket_detected = 1"),
        "frames_total": one("SELECT COUNT(*) FROM youtube_video_frames"),
        "auto": auto_st,
        "semi_auto": semi_st,
        "excluded": one("SELECT COUNT(*) FROM reg_tickets WHERE status IN ('excluded_manual','rejected_shape')"),
        "round_unconfirmed": one("SELECT COUNT(*) FROM ticket_auto_data WHERE round_status <> 'ticket_printed'")
                             + one("SELECT COUNT(*) FROM ticket_semi_auto_data WHERE round_status <> 'ticket_printed'"),
        "ocr_errors": one("SELECT COUNT(*) FROM youtube_video_frames WHERE extraction_status = 'unreadable'"),
        "channel_concentration": {"by_channel": by_channel,
                                  "top_share": round(by_channel[0]["auto_accepted"] / total_acc, 3) if total_acc else None},
        "learning": learning,
        "learning_link": LEARNING_LINK,
        "algorithm_version": ALGORITHM_VERSION,
        "access_policy": "공개 썸네일만 분석(영상 다운로드 없음). 바코드·QR·TR·후원자/판매점 자막·이미지는 저장하지 않음.",
        "api_key": bool(os.environ.get("YOUTUBE_API_KEY")),
    }
