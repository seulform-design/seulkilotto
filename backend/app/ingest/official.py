"""공식 당첨 결과(동행복권) 조회 — 최종 기준 데이터.

2026년 사이트 개편 이후 구 JSON API(`common.do?method=getLottoNumber`)는 메인으로 302
리다이렉트된다(2026-11-10 실측). 결과 페이지(/lt645/result)가 쓰는 공개 JSON 엔드포인트
`/lt645/selectPstLt645InfoNew.do` 를 사용한다: srchDir=center&srchLtEpsd=N → N 주변 10회차.

오류 종류를 구분해 반환한다: network / http / blocked(HTML 응답) / parse / not_published.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

BASE = "https://www.dhlottery.co.kr"
ENDPOINT = BASE + "/lt645/selectPstLt645InfoNew.do"
SOURCE = "dhlottery_official"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; lotto-analyzer/1.0)",
    "Accept": "application/json, text/javascript, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": BASE + "/lt645/result",
}


class OfficialError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


@dataclass
class OfficialDraw:
    round: int
    numbers: List[int]
    bonus: int
    draw_date: str  # YYYY-MM-DD
    prizes: Dict[str, Any] = field(default_factory=dict)
    source: str = SOURCE

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _parse_item(item: Dict[str, Any]) -> OfficialDraw:
    try:
        rnd = int(item["ltEpsd"])
        nums = sorted(int(item[f"tm{i}WnNo"]) for i in range(1, 7))
        bonus = int(item["bnsWnNo"])
        ymd = str(item["ltRflYmd"])
        date = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
    except (KeyError, TypeError, ValueError) as exc:
        raise OfficialError("parse", f"공식 응답 파싱 실패: {exc}") from exc
    if len(set(nums)) != 6 or not all(1 <= n <= 45 for n in nums) or not (1 <= bonus <= 45) or bonus in nums:
        raise OfficialError("parse", f"공식 응답 값 이상: {nums}+{bonus}")
    prizes = {}
    for r in range(1, 6):
        prizes[str(r)] = {
            "winners": item.get(f"rnk{r}WnNope"),
            "amount_per_winner": item.get(f"rnk{r}WnAmt"),
            "total_amount": item.get(f"rnk{r}SumWnAmt"),
        }
    # wholEpsdSumNtslAmt = 회차 총판매액, rlvtEpsdSumNtslAmt = 그 절반(당첨금 재원) — 2026-11-10 실측
    # (1249회: 118,161,409,000 / 59,080,705,168). 판매 게임 수 산정에는 총판매액을 쓴다.
    prizes["total_sales"] = item.get("wholEpsdSumNtslAmt")
    prizes["prize_pool_sales"] = item.get("rlvtEpsdSumNtslAmt")
    return OfficialDraw(rnd, nums, bonus, date, prizes)


def _get(params: Dict[str, str], timeout: float) -> List[Dict[str, Any]]:
    url = ENDPOINT + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise OfficialError("http", f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise OfficialError("network", f"공식 사이트 접속 실패: {exc}") from exc
    if "json" not in ctype.lower():
        raise OfficialError("blocked", f"JSON 이 아닌 응답({ctype or 'unknown'}) — 차단/점검 가능")
    try:
        data = json.loads(body.decode("utf-8"))
    except ValueError as exc:
        raise OfficialError("parse", "JSON 파싱 실패") from exc
    lst = ((data or {}).get("data") or {}).get("list")
    if lst is None:
        raise OfficialError("parse", "응답에 data.list 없음")
    return list(lst)


def fetch_window(center_round: int, *, timeout: float = 15.0) -> List[OfficialDraw]:
    """center_round 주변 회차 목록(공식)."""
    items = _get({"srchDir": "center", "srchLtEpsd": str(int(center_round))}, timeout)
    return [_parse_item(it) for it in items]


def fetch_round(round_no: int, *, timeout: float = 15.0, retries: int = 2) -> OfficialDraw:
    """특정 회차 공식 결과. 아직 발표 전이면 OfficialError('not_published')."""
    last: Optional[OfficialError] = None
    for attempt in range(retries + 1):
        try:
            for d in fetch_window(round_no, timeout=timeout):
                if d.round == int(round_no):
                    return d
            raise OfficialError("not_published", f"{round_no}회 공식 결과 없음(미발표)")
        except OfficialError as exc:
            last = exc
            if exc.kind in ("not_published", "parse"):
                raise
            time.sleep(1.5 * (attempt + 1))
    assert last is not None
    raise last


def fetch_latest_round(known_latest: int, *, timeout: float = 15.0) -> int:
    """공식 최신 회차 — 알고 있는 최신 회차 주변 창을 조회해 최댓값."""
    rounds = [d.round for d in fetch_window(int(known_latest) + 1, timeout=timeout)]
    if not rounds:
        rounds = [d.round for d in fetch_window(int(known_latest), timeout=timeout)]
    if not rounds:
        raise OfficialError("parse", "공식 회차 목록이 비어 있음")
    return max(rounds)


def fetch_range(first: int, last: int, *, delay: float = 1.0, timeout: float = 20.0,
                retries: int = 3, failures: Optional[List[Dict[str, Any]]] = None) -> Dict[int, OfficialDraw]:
    """회차 범위 일괄 조회(10회차 창 단위) — 창별 재시도(지수 백오프), 실패 창은 건너뛰고 기록.

    운영(Railway)에서 연속 대량 요청 시 타임아웃이 관측돼(2026-11-10) 요청 간격을 1초로 두고,
    실패한 창은 `failures` 에 남긴 채 나머지를 계속 조회한다(부분 진행 보존)."""
    out: Dict[int, OfficialDraw] = {}
    r = int(first)
    while r <= last:
        center = min(r + 5, last)
        got: List[OfficialDraw] = []
        err: Optional[OfficialError] = None
        for attempt in range(retries + 1):
            try:
                got = fetch_window(center, timeout=timeout)
                err = None
                break
            except OfficialError as exc:
                err = exc
                if exc.kind == "parse":
                    break
                time.sleep(min(30.0, 2.0 * (2 ** attempt)))
        if err is not None:
            if failures is not None:
                failures.append({"center": center, "kind": err.kind, "error": str(err)[:200]})
            r = center + 5
            time.sleep(delay)
            continue
        for d in got:
            if first <= d.round <= last:
                out[d.round] = d
        nxt = max([k for k in out if k >= r] or [r]) + 1
        r = max(nxt, r + 1)
        time.sleep(delay)
    return out
