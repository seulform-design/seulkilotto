"""유튜브 로또 구매 용지(자동/반자동) 자동 수집 — 공개 썸네일 OCR (영상 다운로드 없음).

정책
----
- 영상 파일·스트림을 내려받지 않는다(YouTube 약관). 대신 YouTube 가 공개 제공하는 썸네일
  이미지(i.ytimg.com/vi/{id}/maxresdefault.jpg)만 분석한다. '첫자동/자동 구매' 영상은
  썸네일에 출력 용지 전체가 보이는 경우가 많다(2026-11-10 실측).
- 영상 프레임·타임스탬프 단위 분석은 하지 않는다 → frame_ref = "thumbnail:maxres".
- 사용자 업로드 경로는 부활시키지 않는다(이 모듈은 서버가 공개 썸네일만 가져온다).

개인정보·식별정보
---------------
용지의 바코드·QR·TR 번호·일련번호·발행 시각은 **저장하지 않는다**(당첨금 수령에 쓰일 수 있는
식별정보). 저장 항목은 회차·게임 라벨·번호·유형·신뢰도뿐이며, 이미지 자체도 저장하지 않는다.

검증 게이트(정식 학습 데이터 조건)
-------------------------------
- 게임 줄: 1~45 서로 다른 6개, **오름차순**(출력 용지는 항상 오름차순) — 아니면 폐기
- OCR 신뢰도 ≥ OCR_MIN, 유형(자동/반자동) 판별 신뢰도 ≥ TYPE_MIN, 회차 확인
- 수동 줄은 학습 제외, 유형 미상 줄은 학습 안 함(pending_review)
- 반자동 용지는 출력물에 '어느 번호를 직접 골랐는지'가 표시되지 않으므로 manual_numbers 는 비워 둔다.
- 영상 속 용지가 실제 구매 완료인지 확인할 수 없으므로 purchase_confirmed = 0.
"""
from __future__ import annotations

import hashlib
import re
import statistics
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import db

OCR_MIN = 0.55
TYPE_MIN = 0.7
THUMB_URL = "https://i.ytimg.com/vi/{vid}/maxresdefault.jpg"
TICKET_QUERIES = ("로또 자동 구매", "로또 첫자동", "로또 반자동 구매", "로또 자동 용지")
DEFAULT_TICKET_CHANNELS = {
    # 2026-11-10 조사: 매주 자동 용지를 썸네일로 공개하는 채널(공개 RSS 로만 접근)
    "UCHHE2qSYZBmhCoi88x06Hdw": "향기나는로또체리",
    "UCYsMzNK3wfjPOrdbBRZINXA": "tess",
    "UCPKHlH9T00dqJtoYZx2zDjg": "당첨돼지",
    "UCJf2SURVvOvtGc8cKfiVNwA": "로또119",
}

_READER = {}


def _reader(langs: Tuple[str, ...]):
    if langs not in _READER:
        import os

        import easyocr

        try:  # 웹 서버와 CPU 를 나눠 쓰므로 OCR 스레드 수 제한
            import torch

            torch.set_num_threads(int(os.environ.get("OCR_THREADS", "2")))
        except Exception:  # noqa: BLE001
            pass
        kw = {}
        mdir = os.environ.get("EASYOCR_MODULE_PATH")
        if mdir and os.path.isdir(os.path.join(mdir, "model")):
            kw = {"model_storage_directory": os.path.join(mdir, "model"), "download_enabled": False}
        _READER[langs] = easyocr.Reader(list(langs), gpu=False, verbose=False, **kw)
    return _READER[langs]


def _center(bbox) -> Tuple[float, float, float]:
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return sum(xs) / 4, sum(ys) / 4, max(ys) - min(ys)


def title_type_hint(title: str) -> Optional[str]:
    t = title or ""
    if "반자동" in t:
        return "semi_auto"
    if "자동" in t:
        return "auto"
    if "수동" in t:
        return "manual"
    return None


def _label_type(text: str) -> Tuple[Optional[str], float]:
    t = re.sub(r"\s+", "", text or "")
    if "반" in t:
        return "semi_auto", 0.9
    if "수" in t:
        return "manual", 0.85
    if "자" in t or "동" in t:
        return "auto", 0.8
    if any(ch in t for ch in "돌둥등똥몽"):  # '동' 의 흔한 오독(실측: '돌')
        return "auto", 0.75
    return None, 0.0


def _digits_in_band(img, x0: int, x1: int, y0: int, y1: int, *, scale: float = 2.0,
                    binarize: bool = False) -> List[Tuple[float, int, float]]:
    import cv2

    band = img[max(0, y0):y1, max(0, x0):x1]
    if band.size == 0:
        return []
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY) if band.ndim == 3 else band
    up = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    if binarize:
        up = cv2.adaptiveThreshold(up, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15)
    out = []
    for bbox, text, conf in _reader(("en",)).readtext(up, allowlist="0123456789 "):
        toks = re.findall(r"\d{2}|\d", text or "")
        for j, tok in enumerate(toks):
            n = int(tok)
            if 1 <= n <= 45:
                cx = _center(bbox)[0] / scale + x0 + j  # 원 좌표계
                out.append((cx, n, float(conf)))
    return out


def _best_window(dedup: List[Tuple[float, int, float]]):
    windows = [dedup[i:i + 6] for i in range(0, max(1, len(dedup) - 5))] if len(dedup) >= 6 else [dedup]
    best = None
    for wdw in windows:
        ns = [d[1] for d in wdw]
        ok = len(ns) == 6 and len(set(ns)) == 6 and all(a < b for a, b in zip(ns, ns[1:]))
        score = (ok, min((d[2] for d in wdw), default=0.0))
        if best is None or score > best[0]:
            best = (score, wdw)
    return best


def _dedup(dig: List[Tuple[float, int, float]], step: float) -> List[Tuple[float, int, float]]:
    dig = sorted(dig)
    out: List[Tuple[float, int, float]] = []
    for d in dig:
        if out and abs(d[0] - out[-1][0]) < step * 0.4:
            if d[2] > out[-1][2]:
                out[-1] = d
        else:
            out.append(d)
    return out


def extract_ticket_lines(image_path: Path, title: str = "") -> Dict[str, Any]:
    """이미지 1장 → {round, lines:[{label, numbers, pick_type, ocr_conf, type_conf, column}], notes}."""
    import cv2

    import numpy as np

    # cv2.imread 는 Windows 비ASCII 경로를 못 읽는다 → 바이트로 읽어 디코드
    img = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "reason": "이미지 로드 실패", "lines": []}
    H, W = img.shape[:2]
    boxes = _reader(("ko", "en")).readtext(img)
    items = []
    for bbox, text, conf in boxes:
        cx, cy, h = _center(bbox)
        t = (text or "").strip()
        x0b = min(p[0] for p in bbox)
        x1b = max(p[0] for p in bbox)
        toks = re.findall(r"(?<!\d)\d{2}(?!\d)", t)
        # 한 상자에 번호가 여러 개('01 14 16')로 읽힌 경우 → 상자 폭을 균등 분할해 번호별 좌표 부여
        if len(toks) >= 2 and re.fullmatch(r"[\d\s]+", t):
            wstep = (x1b - x0b) / len(toks)
            for j, tok in enumerate(toks):
                items.append({"x": x0b + wstep * (j + 0.5), "y": cy, "h": h, "text": tok, "conf": float(conf),
                              "x0": x0b + wstep * j, "split": True})
            continue
        items.append({"x": cx, "y": cy, "h": h, "text": t, "conf": float(conf), "x0": x0b})
    # 회차: '제 NNNN 회' 또는 4자리 숫자 + '회'
    rnd = None
    rounds_seen = []
    for it in items:
        m = re.fullmatch(r"(1\d{3})", it["text"].replace(" ", ""))
        if m and it["conf"] >= 0.3:
            near = [o for o in items if abs(o["y"] - it["y"]) < max(20, it["h"]) and o["text"] in ("제", "회")]
            if near:
                rounds_seen.append(int(m.group(1)))
    for it in items:  # '제 1250 회' · '제1250회' 가 한 상자로 읽힌 경우
        m = re.search(r"제\s*(1\d{3})\s*회", it["text"])
        if m and it["conf"] >= 0.3:
            rounds_seen.append(int(m.group(1)))
    if rounds_seen:
        rnd = max(set(rounds_seen), key=rounds_seen.count)
    # 게임 줄 후보: 두 자리 숫자 박스들을 y 로 군집
    nums = [it for it in items if re.fullmatch(r"\d{2}", it["text"]) and 1 <= int(it["text"]) <= 45]
    if not nums:
        return {"ok": False, "round": rnd, "reason": "번호 줄 없음", "lines": []}
    row_h = statistics.median([n["h"] for n in nums]) or 20
    # 같은 줄 군집: 줄 평균 y 와 비교(연쇄 병합 방지). 나란히 놓인 두 용지의 줄이 몇 px 어긋나도
    # 아래 x 간격 분할로 분리된다.
    nums.sort(key=lambda n: (n["y"], n["x"]))
    rows: List[List[Dict[str, Any]]] = []
    for n in nums:
        placed = False
        for r in rows:
            ry = statistics.mean(o["y"] for o in r)
            if abs(ry - n["y"]) < row_h * 0.45 and all(abs(o["x"] - n["x"]) > row_h * 0.8 for o in r):
                r.append(n)
                placed = True
                break
        if not placed:
            rows.append([n])
    hint = title_type_hint(title)
    lines = []
    for row in rows:
        row.sort(key=lambda n: n["x"])
        # 같은 y 줄에 용지 2장이 나란히 있으면 x 간격이 큰 곳에서 분할
        gaps = [b["x"] - a["x"] for a, b in zip(row, row[1:])]
        med = statistics.median(gaps) if gaps else 0
        segs, cur = [], [row[0]]
        for g, n in zip(gaps, row[1:]):
            if med and g > med * 2.2:
                segs.append(cur)
                cur = [n]
            else:
                cur.append(n)
        segs.append(cur)
        for seg in segs:
            if len(seg) < 4:
                continue
            y = sum(n["y"] for n in seg) / len(seg)
            step = (seg[-1]["x"] - seg[0]["x"]) / max(1, len(seg) - 1)
            x0 = int(seg[0]["x"] - step * 0.5)
            x1 = int(seg[-1]["x"] + step * 0.8)
            # 정밀 재판독(숫자 전용) — 실패 시 3배 확대 + 이진화로 한 번 더
            y0b, y1b = int(y - row_h * 0.8), int(y + row_h * 0.8)
            best = _best_window(_dedup(_digits_in_band(img, x0, x1, y0b, y1b), step))
            if not (best and best[0][0]):
                retry = _best_window(_dedup(_digits_in_band(img, x0, x1, y0b, y1b, scale=3.0, binarize=True), step))
                if retry and (not best or retry[0] > best[0]):
                    best = retry
            chosen = best[1] if best else []
            numbers = [d[1] for d in chosen]
            ocr_conf = min([d[2] for d in chosen], default=0.0)
            valid = bool(best and best[0][0])
            first_pass = [int(n["text"]) for n in seg]
            agree = valid and first_pass == numbers
            if not valid and len(first_pass) == 6 and len(set(first_pass)) == 6 and first_pass == sorted(first_pass):
                numbers, ocr_conf, valid = first_pass, min(n["conf"] for n in seg), True
            if agree:
                # 서로 다른 두 판독(전체 이미지 1차 + 줄 단위 재판독)이 6개 모두 일치 → 신뢰도 보강
                ocr_conf = max(ocr_conf, 0.75)
            # 라벨(게임 문자 + 자동/반자동/수동) — 첫 번호 왼쪽 같은 줄
            left = [o for o in items if abs(o["y"] - y) < row_h * 0.9 and seg[0]["x"] - step * 3.2 < o["x"] < seg[0]["x"] - step * 0.4]
            label_txt = " ".join(o["text"] for o in sorted(left, key=lambda o: o["x"]))
            ptype, tconf = _label_type(label_txt)
            game = next((m for m in re.findall(r"\b([A-E])\b", label_txt)), None)
            if ptype is None and hint in ("auto", "semi_auto"):
                ptype, tconf = hint, 0.6  # 제목 힌트만으로는 기준 미달(검토 대기)
            elif ptype and hint and ptype == hint:
                tconf = min(0.95, tconf + 0.1)
            elif ptype and hint and ptype != hint and hint != "manual":
                tconf = min(tconf, 0.5)  # 라벨·제목 충돌 → 확정 안 함
            lines.append({"_y": y, "_x": seg[0]["x"], "game_label": game, "numbers": numbers, "valid_shape": valid,
                          "ocr_confidence": round(ocr_conf, 3), "pick_type": ptype or "unknown",
                          "type_confidence": round(tconf, 3), "label_text": label_txt,
                          "column": int(seg[0]["x"] // (W / 2)) if W else 0})
    # 격자(칸 단위) 판독으로 보강 — 같은 줄(y·묶음)이면 격자 결과가 형식 검증을 통과할 때 대체/추가
    try:
        grid = extract_grid_lines(img)
    except Exception:  # noqa: BLE001
        grid = []
    for g in grid:
        match = None
        for ln in lines:
            if abs(ln.get("_y", -1e9) - g["y"]) < g["step"] * 0.3 and ln.get("column") == g["column"]:
                match = ln
                break
        label_txt = g.get("label_text") or ""
        ptype, tconf = _label_type(label_txt)
        if ptype is None and hint in ("auto", "semi_auto"):
            ptype, tconf = hint, 0.6
        elif ptype and hint and ptype == hint:
            tconf = min(0.95, tconf + 0.1)
        rec = {"game_label": next((m for m in re.findall(r"([A-E])", label_txt)), None), "numbers": g["numbers"],
               "valid_shape": g["valid_shape"], "ocr_confidence": g["ocr_confidence"], "pick_type": ptype or "unknown",
               "type_confidence": round(tconf, 3), "label_text": label_txt, "column": g["column"], "_y": g["y"],
               "method": "grid"}
        if match is None:
            lines.append(rec)
        elif g["valid_shape"] and (not match["valid_shape"] or g["ocr_confidence"] >= match["ocr_confidence"]):
            match.update(rec)
    # 격자가 유효 줄 3개 이상을 찾은 용지 영역에서는 줄 단위 1차 결과를 버린다(행 혼합 오인식 방지,
    # 실측: 나란히 놓인 두 용지의 A/B 줄이 섞인 '형식은 맞지만 틀린' 줄이 나왔음)
    strong = {}
    for g in grid:
        if g["valid_shape"]:
            strong.setdefault(g["column"], []).append(g)
    regions = [(min(x["x0"] for x in v) - v[0]["step"] * 0.6, max(x["x1"] for x in v) + v[0]["step"] * 0.6)
               for v in strong.values() if len(v) >= 3]
    lines = [ln for ln in lines if ln.get("method") == "grid"
             or not any(a <= ln.get("_x", -1) <= b for a, b in regions)]
    # 같은 번호 줄 중복 제거(두 방식이 같은 줄을 각각 찾은 경우)
    seen_nums = set()
    uniq = []
    for ln in sorted(lines, key=lambda l: (not l["valid_shape"], -l["ocr_confidence"])):
        key = (ln.get("column"), tuple(ln["numbers"]))
        if key in seen_nums:
            continue
        seen_nums.add(key)
        uniq.append(ln)
    lines = uniq
    # 같은 이미지의 다른 줄 라벨로 유형 전파: 라벨로 '자동' 확인된 줄이 2개 이상이고 반자동/수동 라벨이 없으며
    # 제목 힌트도 자동이면, 라벨을 못 읽은 줄도 자동으로 본다(신뢰도 0.75).
    lab_auto = sum(1 for ln in lines if ln["valid_shape"] and _label_type(ln["label_text"])[0] == "auto")
    lab_other = sum(1 for ln in lines if _label_type(ln["label_text"])[0] in ("semi_auto", "manual"))
    if hint == "auto" and lab_auto >= 2 and lab_other == 0:
        for ln in lines:
            if ln["pick_type"] == "auto" and ln["type_confidence"] < 0.75:
                ln["type_confidence"] = 0.75
                ln["type_basis"] = "ticket_majority+title"
    return {"ok": bool(lines), "round": rnd, "lines": lines, "image_size": [W, H]}


def classify_line(line: Dict[str, Any], rnd: Optional[int]) -> str:
    if not line["valid_shape"]:
        return "rejected_shape"
    # 라벨 칸에 게임 문자(A~E)가 둘 이상 → 판독 위치가 두 줄에 걸침(줄 혼합 의심) → 확정 금지
    if len(set(re.findall(r"[A-E]", line.get("label_text") or ""))) >= 2:
        return "pending_review"
    if line["pick_type"] == "manual":
        return "excluded_manual"
    if line["pick_type"] not in ("auto", "semi_auto"):
        return "pending_review"
    if rnd is None or line["ocr_confidence"] < OCR_MIN or line["type_confidence"] < TYPE_MIN:
        return "pending_review"
    return "accepted"


def _hash(video_id: str, rnd: Optional[int], line: Dict[str, Any]) -> str:
    key = f"{rnd}|{line.get('column')}|{line.get('game_label')}|{','.join(map(str, line['numbers']))}|{line['pick_type']}"
    return hashlib.sha1(key.encode()).hexdigest()[:20]


def store_lines(video: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, int]:
    """추출 줄 저장 — 같은 영상·같은 줄 중복 방지(content_hash), 다른 용지는 별개 행."""
    counts: Dict[str, int] = {}
    rnd = result.get("round") or video.get("round_hint")
    with db.transaction() as c:
        for line in result.get("lines", []):
            status = classify_line(line, rnd)
            counts[status] = counts.get(status, 0) + 1
            if status == "rejected_shape":
                continue
            h = _hash(video["video_id"], rnd, line)
            dup = c.execute("SELECT id FROM reg_tickets WHERE content_hash = ?", (h,))
            if dup:
                counts["duplicate"] = counts.get("duplicate", 0) + 1
                continue
            c.execute(
                "INSERT INTO reg_tickets (id,round,video_id,video_url,frame_ref,pick_type,game_label,numbers_json,"
                "manual_numbers_json,ocr_confidence,type_confidence,content_hash,status,purchase_confirmed,collected_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
                (h, rnd, video["video_id"], video["url"], "thumbnail:maxres", line["pick_type"], line.get("game_label"),
                 db.dumps(line["numbers"]), None, line["ocr_confidence"], line["type_confidence"], h, status,
                 db.now_iso()),
            )
    return counts


def fetch_thumbnail(video_id: str, dest_dir: Path) -> Optional[Path]:
    url = THUMB_URL.format(vid=video_id)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; lotto-analyzer/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
    except Exception:  # noqa: BLE001 — maxres 없는 영상 등
        return None
    p = dest_dir / f"{video_id}.jpg"
    p.write_bytes(data)
    return p


def discover_ticket_videos(limit: int = 20) -> Dict[str, Any]:
    from . import youtube

    vids: Dict[str, Any] = {}
    errors = []
    for cid, name in DEFAULT_TICKET_CHANNELS.items():
        try:
            for v in youtube.fetch_channel_feed(cid, name):
                if title_type_hint(v.title) in ("auto", "semi_auto") or "용지" in v.title:
                    vids[v.video_id] = v
        except youtube.YouTubeError as exc:
            errors.append({"channel": cid, "kind": exc.kind, "error": str(exc)})
    for q in TICKET_QUERIES:
        try:
            for v in youtube.api_search(q, max_results=10):
                vids.setdefault(v.video_id, v)
        except youtube.YouTubeError as exc:
            if exc.kind != "no_api_key":
                errors.append({"channel": "api_search", "kind": exc.kind, "error": str(exc)})
            break
    out = sorted(vids.values(), key=lambda v: v.published_at, reverse=True)[:limit]
    return {"videos": out, "errors": errors}


def scan(limit: int = 10, video_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    """신규 용지 영상의 공개 썸네일 OCR → 검증 게이트 → reg_tickets. 이미 스캔한 영상은 건너뜀."""
    from .youtube import _ROUND_RE

    done = {r[0] for r in db.query("SELECT DISTINCT video_id FROM reg_tickets")}
    done |= {r[0] for r in db.query("SELECT video_id FROM reg_youtube WHERE kind = 'ticket_scanned'")}
    if video_ids:
        cands = [{"video_id": v, "title": "", "url": f"https://www.youtube.com/watch?v={v}"} for v in video_ids]
        errors: List[Dict[str, Any]] = []
    else:
        disc = discover_ticket_videos(limit=limit * 3)
        errors = disc["errors"]
        cands = [{"video_id": v.video_id, "title": v.title, "url": v.url, "published_at": v.published_at,
                  "channel_id": v.channel_id, "channel_title": v.channel_title} for v in disc["videos"]]
    report: Dict[str, Any] = {"scanned": 0, "lines": {}, "videos": [], "errors": errors}
    with tempfile.TemporaryDirectory() as td:
        for v in cands:
            if v["video_id"] in done or report["scanned"] >= limit:
                continue
            m = _ROUND_RE.search(v.get("title") or "")
            v["round_hint"] = int(m.group(1)) if m else None
            img = fetch_thumbnail(v["video_id"], Path(td))
            if img is None:
                report["errors"].append({"video_id": v["video_id"], "kind": "thumbnail_missing"})
                continue
            res = extract_ticket_lines(img, v.get("title", ""))
            img.unlink(missing_ok=True)  # 이미지 비보관
            counts = store_lines(v, res)
            _mark_scanned(v)
            report["scanned"] += 1
            for k, n in counts.items():
                report["lines"][k] = report["lines"].get(k, 0) + n
            report["videos"].append({"video_id": v["video_id"], "round": res.get("round") or v["round_hint"], "counts": counts})
    return report


def _mark_scanned(v: Dict[str, Any]) -> None:
    with db.transaction() as c:
        c.execute(
            "INSERT INTO reg_youtube (video_id,channel_id,channel_title,title,url,published_at,round,kind,collected_at) "
            "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (video_id) DO UPDATE SET kind = excluded.kind",
            (v["video_id"], v.get("channel_id"), v.get("channel_title"), v.get("title"), v["url"],
             v.get("published_at"), v.get("round_hint"), "ticket_scanned", db.now_iso()),
        )


# ─────────────────────────────── 분석 ───────────────────────────────

def analysis() -> Dict[str, Any]:
    """자동/반자동을 **분리** 집계 + 실제 당첨과 연결(회차 확정·accepted 만)."""
    from ..stats_engine.draws import load_draws
    from ..stats_engine.probability import match_pmf, prize_rank

    win = {d.round: d for d in load_draws()}
    rows = db.query("SELECT pick_type, round, numbers_json, status, video_id FROM reg_tickets")
    by_status: Dict[str, int] = {}
    out: Dict[str, Any] = {}
    for r in rows:
        by_status[r[3]] = by_status.get(r[3], 0) + 1
    pmf = [float(x) for x in match_pmf()]
    for ptype in ("auto", "semi_auto"):
        sets = [(r[1], db.loads(r[2]), r[4]) for r in rows if r[0] == ptype and r[3] == "accepted"]
        n = len(sets)
        freq = [0] * 46
        odd = [0] * 7
        dec = [0] * 5
        sums = []
        for _, nums, _ in sets:
            for x in nums:
                freq[x] += 1
                dec[min(4, (x - 1) // 10)] += 1
            odd[sum(1 for x in nums if x % 2)] += 1
            sums.append(sum(nums))
        scored = [(rnd, nums) for rnd, nums, _ in sets if rnd in win]
        match_counts = {str(k): 0 for k in range(7)}
        ranks = {str(k): 0 for k in range(1, 6)}
        for rnd, nums in scored:
            d = win[rnd]
            m = len(set(nums) & set(d.numbers))
            match_counts[str(m)] += 1
            pr = prize_rank(nums, d.numbers, d.bonus)
            if pr:
                ranks[str(pr)] += 1
        uniq = len({tuple(s) for _, s, _ in sets})
        out[ptype] = {
            "accepted_lines": n,
            "videos": len({v for _, _, v in sets}),
            "rounds": sorted({r for r, _, _ in sets if r})[-10:],
            "distinct_combinations": uniq,
            "duplicate_combinations": n - uniq,
            "number_frequency": {str(i): freq[i] for i in range(1, 46)},
            "odd_count_distribution": odd,
            "decade_distribution": dec,
            "sum_mean": round(sum(sums) / n, 2) if n else None,
            "scored_against_official": len(scored),
            "match_counts": match_counts,
            "prize_counts": ranks,
            "expected_match_counts_if_uniform": {str(k): round(pmf[k] * len(scored), 3) for k in range(7)},
            "sample_note": ("표본이 작아(30줄 미만) 분포·적중 비교에 통계적 신뢰도가 없습니다." if n < 30 else
                            "특정 채널·이용자에 편중된 표본 — 전체 구매자 대표 표본이 아닙니다."),
        }
    return {
        "kind": "observed_ticket_sample",
        "status_counts": by_status,
        "by_type": out,
        "mixing_policy": "자동과 반자동은 분리 집계(혼합 금지). 수동·유형 미상 줄은 학습 제외.",
        "semi_auto_note": "출력 용지에는 반자동 줄에서 사람이 직접 고른 번호가 구분 표시되지 않아 '직접 선택 번호' 분석은 불가합니다.",
        "privacy": "바코드·QR·TR·일련번호·발행시각·이미지는 저장하지 않습니다.",
        "engine_link": ("6종 학습 엔진의 입력은 '보관 회차 용지(자동/반자동) + 당첨번호' 구조입니다. 유튜브 용지는 "
                        "출처·검증 수준이 달라 기존 보관 데이터에 섞지 않고 별도 DB 로 관리합니다(혼합 금지)."),
        "purchase_confirmed": "영상 속 용지의 실제 구매 완료 여부는 확인할 수 없어 구매 완료 데이터로 간주하지 않습니다.",
    }


# ─────────────────────────── 격자(칸 단위) 판독 ───────────────────────────
# 출력 용지는 게임 줄마다 같은 x 위치(6칸)에 번호가 찍힌다. 전체 이미지 검출은 일부 칸을 놓치므로
# (실측: 선명한 기준 영상 썸네일에서도 5줄 중 2줄만 검출) 검출된 숫자로 행·열 격자를 세운 뒤
# 칸마다 잘라 개별 판독한다.

def _cluster(vals: List[float], tol: float) -> List[List[float]]:
    out: List[List[float]] = []
    for v in sorted(vals):
        if out and abs(statistics.mean(out[-1]) - v) <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return out


def _read_cell(img, cx: float, cy: float, half_w: float, half_h: float) -> Tuple[Optional[int], float]:
    import cv2

    H, W = img.shape[:2]
    x0, x1 = int(max(0, cx - half_w)), int(min(W, cx + half_w))
    y0, y1 = int(max(0, cy - half_h)), int(min(H, cy + half_h))
    crop = img[y0:y1, x0:x1]
    if crop.size == 0:
        return None, 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    up = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    best: Tuple[Optional[int], float] = (None, 0.0)
    for variant in (up, cv2.threshold(up, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]):
        for _b, text, conf in _reader(("en",)).readtext(variant, allowlist="0123456789"):
            t = (text or "").strip()
            if re.fullmatch(r"\d{1,2}", t) and 1 <= int(t) <= 45 and conf > best[1]:
                best = (int(t), float(conf))
    return best


def _read_label(img, x_first: float, y: float, step: float, h: float) -> str:
    """첫 번호 왼쪽의 '게임문자 + 자동/반자동/수동' 라벨 칸만 잘라 한글 판독."""
    import cv2

    H, W = img.shape[:2]
    x0 = int(max(0, x_first - step * 2.1))
    x1 = int(max(0, x_first - step * 0.42))
    y0, y1 = int(max(0, y - h * 0.7)), int(min(H, y + h * 0.7))
    crop = img[y0:y1, x0:x1]
    if crop.size == 0 or x1 <= x0:
        return ""
    up = cv2.resize(crop, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    return " ".join((t or "").strip() for _b, t, c in _reader(("ko", "en")).readtext(up) if c >= 0.05)


def extract_grid_lines(img) -> List[Dict[str, Any]]:
    H, W = img.shape[:2]
    det = []
    for b, text, conf in _reader(("en",)).readtext(img, allowlist="0123456789"):
        t = (text or "").strip()
        if re.fullmatch(r"\d{2}", t) and 1 <= int(t) <= 45 and conf >= 0.3:
            cx, cy, h = _center(b)
            det.append((cx, cy, h))
    if len(det) < 6:
        return []
    h_med = statistics.median(d[2] for d in det)
    # 여러 줄이 합쳐 검출된 키 큰 상자는 행 위치를 왜곡하므로 격자 추정에서 제외
    det = [d for d in det if d[2] <= h_med * 1.5]
    if len(det) < 4:
        return []
    h_med = statistics.median(d[2] for d in det)
    cols = [c for c in _cluster([d[0] for d in det], h_med * 0.9)]
    col_x = [statistics.mean(c) for c in cols if len(c) >= 2]
    singles = [statistics.mean(c) for c in cols if len(c) == 1]
    if len(col_x) < 3:
        return []
    # 6칸씩 묶음(나란히 놓인 용지) — 칸 간격의 2배 넘는 틈에서 분할
    gaps = [b - a for a, b in zip(col_x, col_x[1:])]
    step = statistics.median(gaps)
    groups: List[List[float]] = [[col_x[0]]]
    for g, x in zip(gaps, col_x[1:]):
        if g > step * 1.8:
            groups.append([x])
        else:
            groups[-1].append(x)
    lines = []
    for gi, grp in enumerate(groups):
        if len(grp) < 3 or len(grp) > 6:
            continue
        if len(grp) < 6:
            # 놓친 칸을 등간격 격자로 복원: 관측 칸들을 모두 포함하는 6칸 등차 배치 중 오차 최소
            best = None
            for c in grp:
                for k in range(6):
                    start = c - k * step
                    cand = [start + i * step for i in range(6)]
                    if cand[0] < -step * 0.3 or cand[-1] > W + step * 0.3:
                        continue
                    err = sum(min(abs(x - q) for q in cand) for x in grp)
                    # 동률이면 단일 검출 칸(놓친 칸의 흔적)과 더 많이 맞는 배치를 택한다
                    support = sum(1 for x in singles if min(abs(x - q) for q in cand) < step * 0.3)
                    score = (round(err / step, 1), -support)
                    if all(min(abs(x - q) for q in cand) < step * 0.3 for x in grp) and (best is None or score < best[0]):
                        best = (score, cand)
            if best is None:
                continue
            grp = best[1]
        # 행은 용지(묶음)별로 따로 추정 — 나란히 놓인 두 용지의 줄 높이가 어긋나도 섞이지 않게
        gdet = [d for d in det if grp[0] - step * 0.5 <= d[0] <= grp[-1] + step * 0.5]
        row_y = [statistics.mean(r) for r in _cluster([d[1] for d in gdet], h_med * 0.6) if len(r) >= 2]
        if not row_y:
            continue
        if len(row_y) >= 2:
            diffs = [b - a for a, b in zip(row_y, row_y[1:])]
            rstep = min(diffs)
            if rstep > h_med * 0.6:
                filled = [row_y[0]]
                for a, b in zip(row_y, row_y[1:]):
                    n = max(1, round((b - a) / rstep))
                    filled.extend(a + (b - a) * i / n for i in range(1, n + 1))
                row_y = filled
        for y in row_y:
            near = [d for d in det if abs(d[1] - y) < h_med * 0.7 and grp[0] - step * 0.5 <= d[0] <= grp[-1] + step * 0.5]
            interpolated = len(near) < 2
            if interpolated and not (row_y[0] < y < row_y[-1]):
                continue
            vals, confs = [], []
            for x in grp:
                v, c = _read_cell(img, x, y, step * 0.42, h_med * 0.75)
                vals.append(v)
                confs.append(c)
            if None in vals:
                continue
            ok = len(set(vals)) == 6 and all(a < b for a, b in zip(vals, vals[1:]))
            lines.append({"numbers": vals, "valid_shape": ok, "ocr_confidence": round(min(confs), 3),
                          "y": y, "x0": grp[0], "x1": grp[-1], "step": step, "column": gi,
                          "label_text": _read_label(img, grp[0], y, step, h_med)})
    return lines
