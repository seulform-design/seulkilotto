"""회차 레지스트리 — 수집 → 공식 검증 → 정식 저장(트랜잭션) → CSV 반영.

규칙
----
- 정식 테이블(reg_draws)에는 **공식(동행복권) 결과와 일치 확인된** 회차만 들어간다.
- 유튜브 텍스트에서 번호가 추출됐는데 공식과 다르면 → reg_staging(pending_review), 정식 저장 안 함.
- 동일 회차의 유튜브 영상들끼리 번호가 서로 다르면 → 유튜브 쪽은 youtube_conflict 로 기록(공식이 최종 기준).
- 공식 데이터 접근 불가 → reg_staging(unverified) 로만 보관, 정식 저장·CSV 반영 안 함.
- 기존 회차는 절대 덮어쓰지 않는다. 공식과 다른 기존 값은 reg_staging(conflict) 로 분리 보고.
- 모든 변경은 reg_history 에 append-only 로 남긴다.
- CSV(엔진 입력)는 임시파일 → os.replace 원자적 교체 + 직전본 .bak 보관. 신규 회차 추가만 한다.
"""
from __future__ import annotations

import csv
import hashlib
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import db
from .official import OfficialDraw

STATUS_VERIFIED = "official_verified"
STATUS_LEGACY = "legacy_unverified"  # 기존 CSV 에서 시드됐고 아직 공식 대조 전
CSV_COLUMNS = ["round", "draw_date", "num1", "num2", "num3", "num4", "num5", "num6", "bonus"]


def _csv_path() -> Path:
    from ..database import CSV_DATA_PATH

    return Path(os.environ.get("INGEST_CSV_PATH") or CSV_DATA_PATH)


def read_csv_rows() -> Dict[int, Dict[str, str]]:
    path = _csv_path()
    if not path.exists():
        return {}
    with path.open(encoding="utf-8", newline="") as fp:
        return {int(r["round"]): r for r in csv.DictReader(fp)}


def _row_tuple(r: Dict[str, Any]) -> Tuple[List[int], int, str]:
    return sorted(int(r[f"num{i}"]) for i in range(1, 7)), int(r["bonus"]), str(r.get("draw_date", ""))[:10]


def append_csv_rows(draws: Iterable[OfficialDraw]) -> List[int]:
    """신규 회차만 CSV 에 추가(기존 회차는 건드리지 않음). 원자적 교체 + .bak 보관."""
    path = _csv_path()
    rows = read_csv_rows()
    added: List[int] = []
    for d in draws:
        if d.round in rows:
            continue
        rows[d.round] = {"round": str(d.round), "draw_date": d.draw_date,
                         **{f"num{i + 1}": str(n) for i, n in enumerate(d.numbers)}, "bonus": str(d.bonus)}
        added.append(d.round)
    if not added:
        return []
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
    tmp = path.with_suffix(path.suffix + f".tmp-{uuid.uuid4().hex[:6]}")
    with tmp.open("w", encoding="utf-8", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows):
            w.writerow(rows[r])
    os.replace(tmp, path)
    try:
        from ..database import invalidate_history_cache

        invalidate_history_cache()
    except Exception:  # noqa: BLE001
        pass
    return sorted(added)


def _history(c, rnd: int, action: str, before: Any, after: Any, actor: str) -> None:
    c.execute(
        "INSERT INTO reg_history (id, round, action, before_json, after_json, actor, at) VALUES (?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, int(rnd), action, db.dumps(before) if before is not None else None,
         db.dumps(after) if after is not None else None, actor, db.now_iso()),
    )


def _stage(c, rnd: int, payload: Dict[str, Any], source: str, status: str, reason: str) -> str:
    # 같은 회차·출처·상태·내용이면 중복 적재하지 않는다(반복 수집 멱등)
    key = hashlib.sha1(db.dumps([rnd, payload, source, status]).encode()).hexdigest()[:24]
    exists = c.execute("SELECT id FROM reg_staging WHERE id = ?", (key,))
    if not exists:
        c.execute(
            "INSERT INTO reg_staging (id, round, payload_json, source, status, reason, created_at) VALUES (?,?,?,?,?,?,?)",
            (key, int(rnd), db.dumps(payload), source, status, reason, db.now_iso()),
        )
        _history(c, rnd, f"stage:{status}", None, {"source": source, "reason": reason, **payload}, "pipeline")
    return key


def get_draw(rnd: int) -> Optional[Dict[str, Any]]:
    rows = db.query("SELECT round,n1,n2,n3,n4,n5,n6,bonus,draw_date,verification_status,source,youtube_video_id,"
                    "prizes_json,first_collected_at,last_verified_at,data_version FROM reg_draws WHERE round = ?", (int(rnd),))
    if not rows:
        return None
    r = rows[0]
    return {"round": r[0], "numbers": list(r[1:7]), "bonus": r[7], "draw_date": r[8], "verification_status": r[9],
            "source": r[10], "youtube_video_id": r[11], "prizes": db.loads(r[12]), "first_collected_at": r[13],
            "last_verified_at": r[14], "data_version": r[15]}


def latest_verified_round() -> int:
    rows = db.query("SELECT MAX(round) FROM reg_draws WHERE verification_status = ?", (STATUS_VERIFIED,))
    return int(rows[0][0] or 0) if rows else 0


def seed_from_csv() -> Dict[str, Any]:
    """기존 CSV 회차를 레지스트리에 'legacy_unverified' 로 등록(없는 것만). 기존 데이터 불변."""
    rows = read_csv_rows()
    inserted = 0
    with db.transaction() as c:
        have = {int(r[0]) for r in c.execute("SELECT round FROM reg_draws")}
        now = db.now_iso()
        for rnd, r in rows.items():
            if rnd in have:
                continue
            nums, bonus, date = _row_tuple(r)
            c.execute(
                "INSERT INTO reg_draws (round,n1,n2,n3,n4,n5,n6,bonus,draw_date,verification_status,source,"
                "first_collected_at,data_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT (round) DO NOTHING",
                (rnd, *nums, bonus, date, STATUS_LEGACY, "csv_baseline", now),
            )
            inserted += 1
        if inserted:
            _history(c, 0, "seed_from_csv", None, {"inserted": inserted}, "pipeline")
    return {"inserted": inserted, "csv_rounds": len(rows)}


def compare(official: OfficialDraw, nums: List[int], bonus: int, date: Optional[str]) -> Dict[str, bool]:
    return {
        "round": True,
        "numbers": sorted(nums) == sorted(official.numbers),
        "bonus": int(bonus) == int(official.bonus),
        "date": (date or "")[:10] == official.draw_date if date else True,
    }


def verify_existing(officials: Dict[int, OfficialDraw]) -> Dict[str, Any]:
    """기존(legacy) 회차를 공식과 대조 — 일치: official_verified 로 승격 / 불일치: conflict 스테이징(덮어쓰기 없음)."""
    verified, conflicts, already = [], [], 0
    with db.transaction() as c:
        rows = {int(r[0]): r for r in c.execute(
            "SELECT round,n1,n2,n3,n4,n5,n6,bonus,draw_date,verification_status,data_version FROM reg_draws")}
        now = db.now_iso()
        for rnd, off in sorted(officials.items()):
            r = rows.get(rnd)
            if r is None:
                continue
            nums, bonus, date, status, ver = list(r[1:7]), r[7], r[8], r[9], r[10]
            cmp = compare(off, nums, bonus, date)
            if all(cmp.values()):
                if status == STATUS_VERIFIED:
                    c.execute("UPDATE reg_draws SET last_verified_at = ?, prizes_json = ? WHERE round = ?",
                              (now, db.dumps(off.prizes), rnd))
                    already += 1
                else:
                    c.execute("UPDATE reg_draws SET verification_status = ?, last_verified_at = ?, prizes_json = ?, "
                              "data_version = ? WHERE round = ?", (STATUS_VERIFIED, now, db.dumps(off.prizes), ver + 1, rnd))
                    _history(c, rnd, "verify", {"status": status}, {"status": STATUS_VERIFIED}, "official")
                    verified.append(rnd)
            else:
                _stage(c, rnd, {"stored": {"numbers": nums, "bonus": bonus, "date": date},
                                "official": off.to_dict(), "match": cmp}, "dhlottery_official", "conflict",
                       "기존 저장값과 공식 결과 불일치 — 자동 덮어쓰기 금지, 검토 필요")
                conflicts.append(rnd)
    return {"newly_verified": len(verified), "already_verified": already, "conflicts": conflicts}


def record_youtube(videos: Iterable[Any]) -> int:
    n = 0
    with db.transaction() as c:
        for v in videos:
            ex = v.extracted or {}
            c.execute(
                "INSERT INTO reg_youtube (video_id,channel_id,channel_title,title,url,published_at,round,draw_date,"
                "numbers_json,bonus,text_source,confidence,kind,collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT (video_id) DO NOTHING",
                (v.video_id, v.channel_id, v.channel_title, v.title, v.url, v.published_at, ex.get("round"),
                 ex.get("draw_date"), db.dumps(ex.get("numbers")) if ex.get("numbers") else None, ex.get("bonus"),
                 ex.get("text_source"), ex.get("confidence"), ex.get("kind"), db.now_iso()),
            )
            n += 1
    return n


def youtube_for_round(rnd: int) -> List[Dict[str, Any]]:
    rows = db.query("SELECT video_id,channel_title,title,url,draw_date,numbers_json,bonus,confidence,kind,text_source "
                    "FROM reg_youtube WHERE round = ? AND kind = 'result'", (int(rnd),))
    return [{"video_id": r[0], "channel": r[1], "title": r[2], "url": r[3], "draw_date": r[4],
             "numbers": db.loads(r[5]), "bonus": r[6], "confidence": r[7], "kind": r[8], "text_source": r[9]}
            for r in rows]


def ingest_round(rnd: int, official: Optional[OfficialDraw], *, official_error: Optional[str] = None,
                 secondary: Optional[Dict[str, Any]] = None, write_csv: bool = True) -> Dict[str, Any]:
    """한 회차 수집 결과를 검증해 정식 저장/스테이징. 반환 status:
    duplicate | committed | pending_review | unverified | not_published"""
    rnd = int(rnd)
    existing = get_draw(rnd)
    if existing and existing["verification_status"] == STATUS_VERIFIED:
        return {"round": rnd, "status": "duplicate", "message": "이미 공식 검증된 회차 — 중복 저장 차단"}

    yt = youtube_for_round(rnd)
    yt_with_nums = [v for v in yt if v["numbers"] and v["bonus"]]
    yt_sets = {(tuple(v["numbers"]), v["bonus"]) for v in yt_with_nums}
    yt_conflict = len(yt_sets) > 1

    if official is None:
        payload = {"youtube": yt, "secondary": secondary, "official_error": official_error}
        with db.transaction() as c:
            sid = _stage(c, rnd, payload, "youtube+secondary", "unverified",
                         f"공식 데이터 접근 불가({official_error}) — 자동 확정 안 함")
        return {"round": rnd, "status": "unverified", "staging_id": sid, "official_error": official_error}

    checks: Dict[str, Any] = {"official": official.to_dict()}
    mismatches: List[str] = []
    # 유튜브 텍스트 번호 ↔ 공식
    for v in yt_with_nums:
        cmp = compare(official, v["numbers"], v["bonus"], v["draw_date"])
        v["match"] = cmp
        if not all(cmp.values()):
            mismatches.append(f"youtube:{v['video_id']}")
    # 유튜브 회차·추첨일 ↔ 공식(번호가 없는 영상)
    yt_date_ok = [v for v in yt if v.get("draw_date") == official.draw_date]
    yt_date_bad = [v for v in yt if v.get("draw_date") and v.get("draw_date") != official.draw_date]
    # 보조 출처(lottis 등) ↔ 공식
    if secondary and secondary.get("numbers"):
        cmp = compare(official, secondary["numbers"], secondary["bonus"], secondary.get("draw_date"))
        checks["secondary_match"] = cmp
        if not all(cmp.values()):
            mismatches.append(f"secondary:{secondary.get('source')}")
    if existing:  # legacy 값이 이미 있는데 공식과 다르면 덮어쓰지 않는다
        cmp = compare(official, existing["numbers"], existing["bonus"], existing["draw_date"])
        if not all(cmp.values()):
            mismatches.append("existing_value")
    checks.update(youtube=yt, youtube_conflict=yt_conflict, youtube_date_matched=len(yt_date_ok),
                  youtube_date_mismatched=len(yt_date_bad))

    if mismatches:
        with db.transaction() as c:
            sid = _stage(c, rnd, checks, "dhlottery_official", "pending_review",
                         "불일치: " + ", ".join(mismatches))
        return {"round": rnd, "status": "pending_review", "staging_id": sid, "mismatches": mismatches}

    if yt_with_nums:
        yt_check = "numbers_matched" if not yt_conflict else "youtube_conflict_official_wins"
    elif yt_date_ok:
        yt_check = "round_date_matched"
    else:
        yt_check = "no_youtube_video"
    video_id = (yt_with_nums or yt_date_ok or [{}])[0].get("video_id")

    backup = db.backup_sqlite(f"before-commit-{rnd}")
    with db.transaction() as c:
        now = db.now_iso()
        before = existing
        if existing:
            c.execute("UPDATE reg_draws SET verification_status=?, source=?, youtube_video_id=?, prizes_json=?, "
                      "last_verified_at=?, data_version=data_version+1 WHERE round=?",
                      (STATUS_VERIFIED, existing["source"], video_id, db.dumps(official.prizes), now, rnd))
        else:
            c.execute("INSERT INTO reg_draws (round,n1,n2,n3,n4,n5,n6,bonus,draw_date,verification_status,source,"
                      "youtube_video_id,prizes_json,first_collected_at,last_verified_at,data_version) "
                      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
                      (rnd, *official.numbers, official.bonus, official.draw_date, STATUS_VERIFIED,
                       official.source, video_id, db.dumps(official.prizes), now, now))
        _history(c, rnd, "commit", before, {**official.to_dict(), "youtube_check": yt_check, "video_id": video_id},
                 "pipeline")
        added: List[int] = []
        if write_csv:
            # CSV 반영 실패 시 예외 → 트랜잭션 롤백(정식 DB 와 CSV 불일치 방지)
            added = append_csv_rows([official])
    return {"round": rnd, "status": "committed", "youtube_check": yt_check, "video_id": video_id,
            "csv_added": added, "backup": backup}


def restore_csv_from_registry() -> List[int]:
    """재배포로 CSV 가 이미지 베이스라인으로 되돌아가도, 영구 레지스트리의 공식 검증 회차로 복원(추가만)."""
    rows = db.query("SELECT round,n1,n2,n3,n4,n5,n6,bonus,draw_date,prizes_json FROM reg_draws WHERE verification_status = ?",
                    (STATUS_VERIFIED,))
    csv_rows = read_csv_rows()
    missing = [OfficialDraw(r[0], list(r[1:7]), r[7], r[8], db.loads(r[9]) or {}) for r in rows if r[0] not in csv_rows]
    return append_csv_rows(missing) if missing else []


def staging(status: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    sql = "SELECT id,round,source,status,reason,created_at,resolved_at,payload_json FROM reg_staging"
    params: Tuple[Any, ...] = ()
    if status:
        sql += " WHERE status = ?"
        params = (status,)
    sql += " ORDER BY created_at DESC LIMIT " + str(int(limit))
    return [{"id": r[0], "round": r[1], "source": r[2], "status": r[3], "reason": r[4], "created_at": r[5],
             "resolved_at": r[6], "payload": db.loads(r[7])} for r in db.query(sql, params)]


def summary() -> Dict[str, Any]:
    by_status = {r[0]: int(r[1]) for r in db.query("SELECT verification_status, COUNT(*) FROM reg_draws GROUP BY verification_status")}
    st = {r[0]: int(r[1]) for r in db.query("SELECT status, COUNT(*) FROM reg_staging WHERE resolved_at IS NULL GROUP BY status")}
    yt = db.query("SELECT COUNT(*), MAX(collected_at) FROM reg_youtube")
    last = db.query("SELECT round, last_verified_at, youtube_video_id FROM reg_draws WHERE verification_status = ? "
                    "ORDER BY round DESC LIMIT 1", (STATUS_VERIFIED,))
    return {
        "backend": db.backend(),
        "draws_by_status": by_status,
        "latest_verified_round": last[0][0] if last else None,
        "latest_verified_at": last[0][1] if last else None,
        "latest_youtube_video": last[0][2] if last else None,
        "staging_open": st,
        "youtube_videos": int(yt[0][0]) if yt else 0,
        "youtube_last_collected_at": yt[0][1] if yt else None,
    }
