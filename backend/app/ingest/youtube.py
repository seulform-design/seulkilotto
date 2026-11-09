"""유튜브 회차 결과 영상 수집 — 허용된 접근 경로만 사용.

접근 경로(우선순위)
------------------
1. YouTube Data API v3 `search.list` / `videos.list` — `YOUTUBE_API_KEY` 가 설정된 경우.
2. 채널 공개 RSS 피드 `https://www.youtube.com/feeds/videos.xml?channel_id=...` (키 불필요, 공식 제공).

영상 파일·스트림은 내려받지 않는다(YouTube 약관: 서비스가 제공하는 방식 외 다운로드 금지).
타 채널 자막은 Data API 로도 내려받을 수 없다(captions.download 는 소유자 OAuth 필요) →
자막은 사용하지 않으며 `text_source` 에 실제 사용한 출처(title/description)를 기록한다.

2026-11-10 실측: 회차 결과 영상의 제목·설명에는 회차·추첨일만 있고 번호가 없는 경우가 대부분
(동행복권 공식 채널 포함). 그래서 유튜브 관측은 보통 '회차 발표 신호 + 출처 기록'으로 쓰이고,
번호가 텍스트에 있으면 추출해 공식 결과와 대조한다.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime
from html import unescape
from typing import Any, Dict, List, Optional

# 기본 채널 — 동행복권 공식 + 매주 결과 안내 채널(2026-11-10 검색으로 확인)
DEFAULT_CHANNELS = {
    "UCEk3VwaA6e4H9TW1vSXOjDA": "동행복권(공식)",
    "UC0KrAOpn3iSqoD6x5jgHJGA": "LOTTO",
    "UCluL4zcm7fHb2NM-DUw-aMQ": "Googlinfo",
}
RSS = "https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
API = "https://www.googleapis.com/youtube/v3/"


class YouTubeError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # network | api_quota | api_error | feed_parse | no_api_key


@dataclass
class VideoMeta:
    video_id: str
    channel_id: str
    channel_title: str
    title: str
    description: str
    published_at: str
    url: str = ""
    extracted: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.url:
            self.url = f"https://www.youtube.com/watch?v={self.video_id}"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ─────────────────────────────── 텍스트 추출 ───────────────────────────────

_ROUND_RE = re.compile(r"(?:제\s*)?(?<![\d/])(\d{1,4})\s*회(?!\s*차?\s*예상)")
_DATE_RES = [
    re.compile(r"(20\d{2})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?"),
    re.compile(r"(\d{1,2})\s*월\s*(\d{1,2})\s*일"),
]
_NUMS_RE = re.compile(r"(?<!\d)(\d{1,2})(?!\d)")
_BONUS_RE = re.compile(r"(?:보너스|bonus|\+)\s*[:：]?\s*(\d{1,2})", re.I)
_PREDICTION_HINTS = ("예상", "추천", "분석", "적중", "예측", "꿀팁", "비법")
_RESULT_HINTS = ("당첨번호", "당첨 번호", "추첨 결과", "추첨결과", "결과 안내")


def classify_kind(title: str) -> str:
    t = title or ""
    if "연금" in t or "스피또" in t or ("로또" not in t and "lotto" not in t.lower()):
        return "other_lottery" if "연금" in t or "스피또" in t else "other"
    if any(h in t for h in _PREDICTION_HINTS) and not any(h in t for h in ("당첨번호] ", "추첨 결과 안내")):
        return "prediction"  # 예상·분석 영상 — 번호를 당첨번호로 쓰면 안 됨
    if any(h in t for h in _RESULT_HINTS):
        return "result"
    return "other"


def extract_from_text(title: str, description: str = "", published_year: Optional[int] = None) -> Dict[str, Any]:
    """제목/설명 → {round, draw_date, numbers, bonus, confidence, text_source, kind}.

    신뢰도 규칙(보수적): 결과 영상(kind=result) + 회차 + 1~45 범위 서로 다른 6개 + 보너스가
    한 문단에서 함께 확인될 때만 numbers 를 채운다. 예상/분석 영상의 숫자는 버린다."""
    kind = classify_kind(title)
    out: Dict[str, Any] = {"round": None, "draw_date": None, "numbers": None, "bonus": None,
                           "confidence": 0.0, "text_source": None, "kind": kind}
    m = _ROUND_RE.search(title or "")
    if m:
        out["round"] = int(m.group(1))
    for rx in _DATE_RES:
        dm = rx.search(title or "") or rx.search(description or "")
        if dm:
            g = dm.groups()
            try:
                if len(g) == 3:
                    out["draw_date"] = f"{int(g[0]):04d}-{int(g[1]):02d}-{int(g[2]):02d}"
                elif published_year:
                    out["draw_date"] = f"{published_year:04d}-{int(g[0]):02d}-{int(g[1]):02d}"
            except ValueError:
                pass
            if out["draw_date"]:
                break
    conf = 0.0
    if out["round"]:
        conf += 0.3
    if out["draw_date"]:
        conf += 0.1
    if kind == "result":
        conf += 0.1
        for src_name, text in (("title", title or ""), ("description", description or "")):
            for para in re.split(r"\n\s*\n|\|", text):
                cleaned = _ROUND_RE.sub(" ", para)
                for rx in _DATE_RES:
                    cleaned = rx.sub(" ", cleaned)
                bm = _BONUS_RE.search(cleaned)
                bonus = int(bm.group(1)) if bm else None
                body = cleaned[: bm.start()] if bm else cleaned
                nums = [int(x) for x in _NUMS_RE.findall(body) if 1 <= int(x) <= 45]
                if len(nums) == 6 and len(set(nums)) == 6 and bonus and 1 <= bonus <= 45 and bonus not in nums:
                    out.update(numbers=sorted(nums), bonus=bonus, text_source=src_name)
                    conf += 0.5
                    break
            if out["numbers"]:
                break
    out["confidence"] = round(min(conf, 1.0), 2)
    return out


# ─────────────────────────────── 수집 ───────────────────────────────

def _http_get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; lotto-analyzer/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise YouTubeError("api_quota", f"HTTP 403 (쿼터/권한): {url[:80]}") from exc
        if exc.code == 404:
            raise YouTubeError("not_found", f"HTTP 404(채널/영상 없음): {url[:80]}") from exc
        raise YouTubeError("api_error", f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise YouTubeError("network", str(exc)) from exc


def parse_rss(xml: str, channel_title: str = "") -> List[VideoMeta]:
    vids: List[VideoMeta] = []
    for e in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
        def g(pat: str) -> str:
            m = re.search(pat, e, re.S)
            return unescape(m.group(1)) if m else ""
        vid = g(r"<yt:videoId>(.*?)</yt:videoId>")
        if not vid:
            continue
        vids.append(VideoMeta(
            video_id=vid,
            channel_id=g(r"<yt:channelId>(.*?)</yt:channelId>"),
            channel_title=channel_title or g(r"<name>(.*?)</name>"),
            title=g(r"<title>(.*?)</title>"),
            description=g(r"<media:description>(.*?)</media:description>"),
            published_at=g(r"<published>(.*?)</published>"),
        ))
    return vids


def fetch_channel_feed(channel_id: str, channel_title: str = "") -> List[VideoMeta]:
    raw = _http_get(RSS.format(cid=urllib.parse.quote(channel_id)))
    try:
        return parse_rss(raw.decode("utf-8"), channel_title)
    except Exception as exc:  # noqa: BLE001
        raise YouTubeError("feed_parse", str(exc)) from exc


def api_search(query: str, *, max_results: int = 25, published_after: Optional[str] = None) -> List[VideoMeta]:
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        raise YouTubeError("no_api_key", "YOUTUBE_API_KEY 미설정 — RSS 경로만 사용")
    params = {"part": "snippet", "q": query, "type": "video", "maxResults": str(max_results),
              "order": "date", "regionCode": "KR", "relevanceLanguage": "ko", "key": key}
    if published_after:
        params["publishedAfter"] = published_after
    data = json.loads(_http_get(API + "search?" + urllib.parse.urlencode(params)).decode("utf-8"))
    out = []
    for it in data.get("items", []):
        sn = it.get("snippet") or {}
        vid = (it.get("id") or {}).get("videoId")
        if vid:
            out.append(VideoMeta(vid, sn.get("channelId", ""), sn.get("channelTitle", ""),
                                 unescape(sn.get("title", "")), unescape(sn.get("description", "")),
                                 sn.get("publishedAt", "")))
    return out


def channels() -> Dict[str, str]:
    extra = os.environ.get("YOUTUBE_CHANNEL_IDS", "").strip()
    out = dict(DEFAULT_CHANNELS)
    for cid in filter(None, (x.strip() for x in extra.split(","))):
        out.setdefault(cid, cid)
    return out


def discover(round_hint: Optional[int] = None) -> Dict[str, Any]:
    """채널 RSS(+API 키가 있으면 검색)로 결과 영상 수집 → 추출. 채널별 오류는 분리 기록."""
    videos: Dict[str, VideoMeta] = {}
    errors: List[Dict[str, str]] = []
    for cid, name in channels().items():
        try:
            for v in fetch_channel_feed(cid, name):
                videos[v.video_id] = v
        except YouTubeError as exc:
            errors.append({"channel": cid, "kind": exc.kind, "error": str(exc)})
    if round_hint:
        try:
            for v in api_search(f"로또 {round_hint}회 당첨번호"):
                videos.setdefault(v.video_id, v)
        except YouTubeError as exc:
            errors.append({"channel": "api_search", "kind": exc.kind, "error": str(exc)})
    for v in videos.values():
        year = None
        try:
            year = datetime.fromisoformat(v.published_at.replace("Z", "+00:00")).year
        except ValueError:
            pass
        v.extracted = extract_from_text(v.title, v.description, year)
    return {"videos": list(videos.values()), "errors": errors}
