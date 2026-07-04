"""용지 사진 분석 결과 누적 저장 (SQLite-backed)."""
from __future__ import annotations

import functools
import json
import sqlite3
import threading
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from . import pg_store
from .dedup import compute_content_fingerprint, compute_ticket_fingerprint, find_duplicate_entry
from .overlap_patterns import accumulate_frequency_patterns, build_frequency_overlap_patterns
from .position_template import build_sheet_template, merge_review_templates

# 저장소 쓰기 직렬화 락 — 모든 변경(append/delete/clear/rollover 등)은
# load→수정→save 를 통째로 수행하므로, 동시 요청이 겹치면 마지막 쓰기가
# 다른 쓰기를 덮어써(lost update) 항목이 사라질 수 있다. 변경 함수를
# 이 락으로 직렬화한다(단일 워커 기준). 읽기는 잠그지 않는다.
_WRITE_LOCK = threading.RLock()


def _synchronized(fn):
    @functools.wraps(fn)
    def _wrapper(*args, **kwargs):
        with _WRITE_LOCK:
            return fn(*args, **kwargs)

    return _wrapper


class DuplicateAnalysisError(Exception):
    """이미 저장된 동일 영상/용지."""

    def __init__(self, reason: str, existing_entry: Dict[str, Any]):
        self.reason = reason
        self.existing_entry = existing_entry
        super().__init__(self._message(reason, existing_entry))

    @staticmethod
    def _message(reason: str, entry: Dict[str, Any]) -> str:
        title = entry.get("video_title") or entry.get("url") or "기존 분석"
        rnd = entry.get("ticket_round") or "?"
        if reason == "same_source":
            return f"이미 분석된 사진입니다: {title}"
        return f"동일 용지가 이미 저장되어 있습니다 ({rnd}회): {title}"

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STORE_PATH = DATA_DIR / "video_analysis_store.json"
CURRENT_STORE_BASENAME = "video_analysis_current_store.json"
HISTORICAL_STORE_VERSION = 3
CURRENT_STORE_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _current_store_path() -> Path:
    return STORE_PATH.with_name(CURRENT_STORE_BASENAME)


def _db_path() -> Path:
    return STORE_PATH.with_suffix(".db")


def _empty_historical_raw() -> Dict[str, Any]:
    return {
        "version": HISTORICAL_STORE_VERSION,
        "updated_at": _now_iso(),
        "entries": [],
        "archived_current_rounds": [],
    }


def _default_current_round_no() -> int:
    try:
        from .draw_template import get_current_round_no

        return int(get_current_round_no())
    except Exception:
        return 0


def _empty_current_raw(round_no: int | None = None) -> Dict[str, Any]:
    return {
        "version": CURRENT_STORE_VERSION,
        "updated_at": _now_iso(),
        "current_round": int(round_no if round_no is not None else _default_current_round_no()),
        "status": "open",
        "entries": [],
        "derived_datasets": {},
        "rule_snapshots": {},
        "frozen_at": None,
    }


def _connect_db() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS store_meta (
            scope TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS historical_review_entries (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT UNIQUE NOT NULL,
            analyzed_at TEXT,
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS archived_current_batches (
            round_no INTEGER PRIMARY KEY,
            merged_at TEXT,
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS current_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            round_no INTEGER NOT NULL,
            status TEXT NOT NULL,
            frozen_at TEXT,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS current_entries (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT UNIQUE NOT NULL,
            round_no INTEGER NOT NULL,
            analyzed_at TEXT,
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS current_derived_datasets (
            name TEXT PRIMARY KEY,
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS current_rule_snapshots (
            name TEXT PRIMARY KEY,
            payload TEXT NOT NULL
        );
        """
    )
    return conn


def _update_meta(conn: sqlite3.Connection, scope: str, version: int, updated_at: str) -> None:
    conn.execute(
        """
        INSERT INTO store_meta(scope, version, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
            version = excluded.version,
            updated_at = excluded.updated_at
        """,
        (scope, version, updated_at),
    )


def _meta_updated_at(conn: sqlite3.Connection, scope: str) -> str | None:
    row = conn.execute("SELECT updated_at FROM store_meta WHERE scope = ?", (scope,)).fetchone()
    return str(row["updated_at"]) if row and row["updated_at"] else None


def _db_has_content(conn: sqlite3.Connection) -> bool:
    checks = (
        "SELECT 1 FROM historical_review_entries LIMIT 1",
        "SELECT 1 FROM archived_current_batches LIMIT 1",
        "SELECT 1 FROM current_entries LIMIT 1",
        "SELECT 1 FROM current_state LIMIT 1",
    )
    return any(conn.execute(sql).fetchone() is not None for sql in checks)


def _load_json_store(path: Path, default_factory) -> Dict[str, Any]:
    if not path.exists():
        return default_factory()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("invalid store")
        return data
    except Exception:
        return default_factory()


def _save_json_store(path: Path, data: Dict[str, Any], version: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.loads(json.dumps(data, ensure_ascii=False))
    payload["updated_at"] = _now_iso()
    payload["version"] = version
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def _write_historical_raw_db(conn: sqlite3.Connection, data: Dict[str, Any]) -> None:
    payload = _deep_copy(data)
    entries = payload.get("entries") or []
    archived = payload.get("archived_current_rounds") or []
    updated_at = str(payload.get("updated_at") or _now_iso())
    version = int(payload.get("version") or HISTORICAL_STORE_VERSION)

    conn.execute("DELETE FROM historical_review_entries")
    conn.execute("DELETE FROM archived_current_batches")
    for entry in entries:
        conn.execute(
            "INSERT INTO historical_review_entries(entry_id, analyzed_at, payload) VALUES (?, ?, ?)",
            (
                str(entry.get("id") or uuid.uuid4()),
                str(entry.get("analyzed_at") or ""),
                json.dumps(entry, ensure_ascii=False),
            ),
        )
    for batch in archived:
        round_no = int(batch.get("round_no") or 0)
        if round_no <= 0:
            continue
        conn.execute(
            "INSERT INTO archived_current_batches(round_no, merged_at, payload) VALUES (?, ?, ?)",
            (
                round_no,
                str(batch.get("merged_at") or ""),
                json.dumps(batch, ensure_ascii=False),
            ),
        )
    _update_meta(conn, "historical", version, updated_at)


def _write_current_raw_db(conn: sqlite3.Connection, data: Dict[str, Any]) -> None:
    payload = _deep_copy(data)
    entries = payload.get("entries") or []
    derived = payload.get("derived_datasets") or {}
    snapshots = payload.get("rule_snapshots") or {}
    updated_at = str(payload.get("updated_at") or _now_iso())
    version = int(payload.get("version") or CURRENT_STORE_VERSION)
    round_no = int(payload.get("current_round") or _default_current_round_no())
    status = str(payload.get("status") or "open")
    frozen_at = payload.get("frozen_at")

    conn.execute("DELETE FROM current_entries")
    conn.execute("DELETE FROM current_derived_datasets")
    conn.execute("DELETE FROM current_rule_snapshots")
    conn.execute(
        """
        INSERT INTO current_state(id, round_no, status, frozen_at, updated_at, version)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            round_no = excluded.round_no,
            status = excluded.status,
            frozen_at = excluded.frozen_at,
            updated_at = excluded.updated_at,
            version = excluded.version
        """,
        (round_no, status, frozen_at, updated_at, version),
    )
    for entry in entries:
        conn.execute(
            "INSERT INTO current_entries(entry_id, round_no, analyzed_at, payload) VALUES (?, ?, ?, ?)",
            (
                str(entry.get("id") or uuid.uuid4()),
                round_no,
                str(entry.get("analyzed_at") or ""),
                json.dumps(entry, ensure_ascii=False),
            ),
        )
    for name, item in derived.items():
        conn.execute(
            "INSERT INTO current_derived_datasets(name, payload) VALUES (?, ?)",
            (str(name), json.dumps(item, ensure_ascii=False)),
        )
    for name, item in snapshots.items():
        conn.execute(
            "INSERT INTO current_rule_snapshots(name, payload) VALUES (?, ?)",
            (str(name), json.dumps(item, ensure_ascii=False)),
        )
    _update_meta(conn, "current", version, updated_at)


def _read_historical_raw_db(conn: sqlite3.Connection) -> Dict[str, Any]:
    entries = [
        json.loads(row["payload"])
        for row in conn.execute(
            "SELECT payload FROM historical_review_entries ORDER BY seq ASC"
        ).fetchall()
    ]
    archived = [
        json.loads(row["payload"])
        for row in conn.execute(
            "SELECT payload FROM archived_current_batches ORDER BY round_no ASC"
        ).fetchall()
    ]
    return {
        "version": HISTORICAL_STORE_VERSION,
        "updated_at": _meta_updated_at(conn, "historical") or _now_iso(),
        "entries": entries,
        "archived_current_rounds": archived,
    }


def _read_current_raw_db(conn: sqlite3.Connection) -> Dict[str, Any]:
    state_row = conn.execute(
        "SELECT round_no, status, frozen_at, updated_at, version FROM current_state WHERE id = 1"
    ).fetchone()
    if state_row is None:
        return _empty_current_raw()
    entries = [
        json.loads(row["payload"])
        for row in conn.execute(
            "SELECT payload FROM current_entries ORDER BY seq ASC"
        ).fetchall()
    ]
    derived = {
        str(row["name"]): json.loads(row["payload"])
        for row in conn.execute("SELECT name, payload FROM current_derived_datasets").fetchall()
    }
    snapshots = {
        str(row["name"]): json.loads(row["payload"])
        for row in conn.execute("SELECT name, payload FROM current_rule_snapshots").fetchall()
    }
    return {
        "version": int(state_row["version"] or CURRENT_STORE_VERSION),
        "updated_at": str(state_row["updated_at"] or _now_iso()),
        "current_round": int(state_row["round_no"] or _default_current_round_no()),
        "status": str(state_row["status"] or "open"),
        "entries": entries,
        "derived_datasets": derived,
        "rule_snapshots": snapshots,
        "frozen_at": state_row["frozen_at"],
    }


def _strip_for_store(result: Dict[str, Any]) -> Dict[str, Any]:
    out = json.loads(json.dumps(result, ensure_ascii=False))
    meta = out.get("meta")
    if isinstance(meta, dict):
        meta.pop("preview_image_base64", None)
    vva = out.get("video_visual_analysis") or {}
    if isinstance(vva, dict):
        vva.pop("round_sources", None)
    return out


def _entry_round(entry: Dict[str, Any]) -> str:
    r = entry.get("ticket_round")
    if r:
        return str(r)
    vva = (entry.get("result") or {}).get("video_visual_analysis") or {}
    return str(vva.get("ticket_round") or vva.get("detected_round") or "미확인")


def _deep_copy(data: Any) -> Any:
    return json.loads(json.dumps(data, ensure_ascii=False))


def _maybe_migrate_legacy_store() -> None:
    with _connect_db() as conn:
        if _db_has_content(conn):
            return

        historical_raw = _load_json_store(STORE_PATH, _empty_historical_raw)
        current_raw = _load_json_store(_current_store_path(), _empty_current_raw)
        entries = historical_raw.get("entries") or []
        if entries and not (current_raw.get("entries") or []):
            current_entries = [e for e in entries if e.get("video_intent") == "current_round"]
            if current_entries:
                historical_raw["entries"] = [e for e in entries if e.get("video_intent") != "current_round"]
                historical_raw["archived_current_rounds"] = historical_raw.get("archived_current_rounds") or []
                round_candidates = [
                    int(_entry_round(e))
                    for e in current_entries
                    if str(_entry_round(e)).isdigit()
                ]
                current_raw = _empty_current_raw(max(round_candidates) if round_candidates else None)
                current_raw["entries"] = current_entries
        _write_historical_raw_db(conn, historical_raw)
        _write_current_raw_db(conn, current_raw)
        conn.commit()


def _ensure_db_ready() -> None:
    _maybe_migrate_legacy_store()


def _normalize_historical(data: Dict[str, Any]) -> Dict[str, Any]:
    data.setdefault("entries", [])
    data.setdefault("archived_current_rounds", [])
    data.setdefault("version", HISTORICAL_STORE_VERSION)
    return data


def _normalize_current(data: Dict[str, Any]) -> Dict[str, Any]:
    data.setdefault("entries", [])
    data.setdefault("derived_datasets", {})
    data.setdefault("rule_snapshots", {})
    data.setdefault("status", "open")
    data.setdefault("frozen_at", None)
    if "current_round" not in data:
        data["current_round"] = _default_current_round_no()
    data.setdefault("version", CURRENT_STORE_VERSION)
    return data


def _load_historical_raw() -> Dict[str, Any]:
    if pg_store.enabled():
        return _normalize_historical(pg_store.load("historical") or _empty_historical_raw())
    _ensure_db_ready()
    with _connect_db() as conn:
        return _read_historical_raw_db(conn)


def _save_historical_raw(data: Dict[str, Any]) -> None:
    payload = _deep_copy(data)
    payload.setdefault("entries", [])
    payload.setdefault("archived_current_rounds", [])
    payload.setdefault("version", HISTORICAL_STORE_VERSION)
    payload["updated_at"] = _now_iso()
    if pg_store.enabled():
        pg_store.save("historical", payload)
        return
    _ensure_db_ready()
    with _connect_db() as conn:
        _write_historical_raw_db(conn, payload)
        conn.commit()


def _load_current_raw() -> Dict[str, Any]:
    if pg_store.enabled():
        return _normalize_current(pg_store.load("current") or _empty_current_raw())
    _ensure_db_ready()
    with _connect_db() as conn:
        data = _read_current_raw_db(conn)
    data.setdefault("entries", [])
    data.setdefault("derived_datasets", {})
    data.setdefault("rule_snapshots", {})
    data.setdefault("status", "open")
    data.setdefault("frozen_at", None)
    if "current_round" not in data:
        data["current_round"] = _default_current_round_no()
    data.setdefault("version", CURRENT_STORE_VERSION)
    return data


def _save_current_raw(data: Dict[str, Any]) -> None:
    payload = _deep_copy(data)
    payload.setdefault("entries", [])
    payload.setdefault("derived_datasets", {})
    payload.setdefault("rule_snapshots", {})
    payload.setdefault("status", "open")
    payload.setdefault("frozen_at", None)
    if "current_round" not in payload:
        payload["current_round"] = _default_current_round_no()
    payload.setdefault("version", CURRENT_STORE_VERSION)
    payload["updated_at"] = _now_iso()
    if pg_store.enabled():
        pg_store.save("current", payload)
        return
    _ensure_db_ready()
    with _connect_db() as conn:
        _write_current_raw_db(conn, payload)
        conn.commit()


def _archived_current_entries(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    archived: List[Dict[str, Any]] = []
    for batch in data.get("archived_current_rounds") or []:
        archived.extend(batch.get("entries") or [])
    return archived


def store_signature() -> str:
    """저장소 상태 경량 시그니처 — 저장/삭제 시 값이 바뀐다.

    예측 신호 등 무거운 파생 계산의 캐시 무효화 키로 쓴다. updated_at +
    엔트리 수만 보므로 전체 재계산보다 훨씬 싸고, 영속 타임스탬프 기반이라
    워커 간에도 일관적이다.
    """
    try:
        historical = _load_historical_raw()
        current = _load_current_raw()
        return (
            f"{historical.get('updated_at', '')}|{len(historical.get('entries') or [])}|"
            f"{current.get('updated_at', '')}|{len(current.get('entries') or [])}"
        )
    except Exception:  # noqa: BLE001
        return ""


def _live_entries() -> List[Dict[str, Any]]:
    historical = _load_historical_raw()
    current = _load_current_raw()
    return list(historical.get("entries") or []) + list(current.get("entries") or [])


def _all_duplicate_scan_entries() -> List[Dict[str, Any]]:
    historical = _load_historical_raw()
    current = _load_current_raw()
    return (
        list(historical.get("entries") or [])
        + _archived_current_entries(historical)
        + list(current.get("entries") or [])
    )


def check_stored_duplicate(
    source_id: str,
    result: Dict[str, Any] | None = None,
    *,
    allow_duplicate: bool = False,
) -> Dict[str, Any] | None:
    """저장소에 동일 사진/용지가 있으면 기존 엔트리 반환."""
    if allow_duplicate:
        return None
    entries = _all_duplicate_scan_entries()
    sid = (result or {}).get("video_visual_analysis", {}).get("video_id") or source_id

    if sid:
        hit = find_duplicate_entry(entries, source_id=sid)
        if hit:
            return hit

    if result:
        fp = compute_ticket_fingerprint(result)
        content_fp = compute_content_fingerprint(result)
        hit = find_duplicate_entry(
            entries,
            ticket_fingerprint=fp,
            content_fingerprint=content_fp or None,
            exclude_source_id=sid,
        )
        if hit:
            return hit
    return None


@_synchronized
def _entry_pick_type(e: Dict[str, Any]) -> str:
    """엔트리의 픽 타입(자동/반자동). 미기록 구엔트리는 과거 전량 반자동이었으므로 반자동으로 간주."""
    pt = str(e.get("pick_type") or "").strip()
    if pt:
        return pt
    pt = str(((e.get("result") or {}).get("meta") or {}).get("pick_type") or "").strip()
    return pt or "반자동"


def append_analysis(
    source_id: str,
    result: Dict[str, Any],
    *,
    allow_duplicate: bool = False,
    source_label: str = "",
    replace_existing: bool = False,
    replace_prior_manual: bool = False,
) -> Dict[str, Any]:
    _vva0 = result.get("video_visual_analysis") or {}
    _meta0 = result.get("meta") or {}
    _mode0 = str(_meta0.get("entry_mode") or "photo")
    _pick0 = str(_meta0.get("pick_type") or "").strip() or "반자동"
    _intent0 = str(_vva0.get("video_intent") or _meta0.get("sheet_intent") or "")
    # 수기/대량 저장은 '현재 전체 세트'를 뜻한다 — 같은 회차·intent 의 기존 수기
    # 엔트리를 지우고 새로 저장해 재저장 시 통계가 누적(중복)되지 않게 한다.
    # entry_mode 미기록 구엔트리는 저장된 result.meta 로 역추론(하위호환 치유).
    def _is_manual(e: Dict[str, Any]) -> bool:
        if str(e.get("entry_mode") or "") == "manual":
            return True
        return str(((e.get("result") or {}).get("meta") or {}).get("entry_mode") or "") == "manual"

    # 같은 intent + 같은 픽 타입의 이전 수기 세트만 교체한다.
    # (자동/반자동은 서로 독립 세트 — 반자동 저장이 자동 저장을 지우지 않게 한다.)
    if replace_prior_manual and _mode0 == "manual":
        for prior in list(_live_entries()):
            if (
                _is_manual(prior)
                and str(prior.get("video_intent") or "") == _intent0
                and _entry_pick_type(prior) == _pick0
            ):
                delete_entry(str(prior.get("id")))

    existing = check_stored_duplicate(source_id, result, allow_duplicate=allow_duplicate)
    if existing:
        sid = (result.get("video_visual_analysis") or {}).get("video_id") or source_id
        same_source = bool(sid and (existing.get("image_id") or existing.get("video_id")) == sid)
        if replace_existing and same_source:
            delete_entry(str(existing.get("id")))
            existing = None
        else:
            reason = "same_source" if same_source else "same_ticket"
            raise DuplicateAnalysisError(reason, existing)

    vva = result.get("video_visual_analysis") or {}
    evp = result.get("extracted_visual_patterns") or {}
    fop = evp.get("frequency_overlap_patterns") or build_frequency_overlap_patterns({})
    ticket_fp = compute_ticket_fingerprint(result)
    content_fp = compute_content_fingerprint(result)
    label = source_label or vva.get("video_title") or source_id

    meta = result.get("meta") or {}
    evp_full = result.get("extracted_visual_patterns") or {}

    entry_mode = str(meta.get("entry_mode") or "photo")
    pick_type = str(meta.get("pick_type") or "").strip() or (
        "반자동" if entry_mode == "manual" else ""
    )
    entry = {
        "id": str(uuid.uuid4()),
        "source_type": "photo",
        "entry_mode": entry_mode,
        "pick_type": pick_type,
        "source_id": source_id,
        "image_id": vva.get("video_id") or source_id,
        "source_label": label,
        "url": label,
        "video_id": vva.get("video_id") or source_id,
        "ticket_fingerprint": ticket_fp,
        "content_fingerprint": content_fp,
        "video_title": label,
        "ticket_round": vva.get("ticket_round") or vva.get("detected_round"),
        "ticket_round_confidence": vva.get("ticket_round_confidence"),
        "video_intent": vva.get("video_intent"),
        "video_intent_label": vva.get("video_intent_label"),
        "referenced_rounds": vva.get("referenced_rounds") or [],
        "detected_round": vva.get("detected_round"),
        "frequency_overlap_patterns": fop,
        "triple_plus_overlap": fop.get("triple_plus_overlap") or evp.get("triple_plus_overlap"),
        "combo_patterns": evp_full.get("combo_patterns") or meta.get("combo_patterns"),
        "position_template": (
            meta.get("photo_review_template")
            or meta.get("position_template")
            or evp_full.get("photo_review_template")
            or evp_full.get("position_template")
        ),
        "analyzed_at": _now_iso(),
        "result": _strip_for_store(result),
    }
    if entry.get("video_intent") == "current_round":
        entry_round = int(str(entry.get("ticket_round") or 0) or 0)
        current_data = _auto_align_current_sandbox_round(entry_round) if entry_round > 0 else _load_current_raw()
        entry_round = int(str(entry.get("ticket_round") or current_data.get("current_round") or 0) or 0)
        if current_data.get("entries") and int(current_data.get("current_round") or 0) != entry_round:
            raise ValueError(
                "현재회차 샌드박스가 다른 회차를 가리키고 있습니다. "
                "회차 롤오버를 먼저 완료한 뒤 다시 시도하세요."
            )
        if not current_data.get("entries"):
            current_data["current_round"] = entry_round or int(current_data.get("current_round") or 0)
        current_data["status"] = "open"
        current_data["entries"].append(entry)
        # 내용 중복 자기치유 — 같은 줄 묶음 중복 엔트리 제거(최신 유지).
        current_data["entries"] = _dedupe_entries_by_content(current_data["entries"])
        _refresh_current_dataset(current_data)
        _save_current_raw(current_data)
    else:
        data = _load_historical_raw()
        data["entries"].append(entry)
        data["entries"] = _dedupe_entries_by_content(data["entries"])
        _save_historical_raw(data)
    return entry


def _current_dataset_summary(current_data: Dict[str, Any]) -> Dict[str, Any]:
    entries = current_data.get("entries") or []
    entry_acc = _accumulate_entries(entries) if entries else {"final_predictions": {"strong_candidates": [], "excluded_candidates": []}}
    combo = _recompute_intent_combo(entries, "current_round") if entries else {
        "summary": "분석 없음",
        "pair_duplicates": [],
        "triple_duplicates": [],
    }
    return {
        "round_no": int(current_data.get("current_round") or 0),
        "generated_at": _now_iso(),
        "entry_count": len(entries),
        "final_predictions": entry_acc.get("final_predictions") or {
            "strong_candidates": [],
            "excluded_candidates": [],
        },
        "accumulated_combo_patterns": combo,
    }


def _historical_draw_result(round_no: int) -> tuple[List[int], int] | None:
    from ..database import load_history

    df = load_history()
    if df.empty:
        return None
    row = df[df["round"].astype(int) == int(round_no)]
    if row.empty:
        return None
    row0 = row.sort_values("round").iloc[-1]
    return ([int(row0[f"num{i}"]) for i in range(1, 7)], int(row0["bonus"]))


def _auto_align_current_sandbox_round(target_round: int) -> Dict[str, Any]:
    current_data = _load_current_raw()
    current_round = int(current_data.get("current_round") or 0)
    if current_round >= target_round:
        return current_data

    while current_data.get("entries") and current_round < target_round:
        draw = _historical_draw_result(current_round)
        if draw is None:
            break
        winning_numbers, bonus = draw
        rollover = rollover_current_dataset(
            drawn_round=current_round,
            next_round=current_round + 1,
            winning_numbers=winning_numbers,
            bonus=bonus,
        )
        if rollover.get("ok") is not True:
            break
        current_data = _load_current_raw()
        current_round = int(current_data.get("current_round") or 0)
        if rollover.get("reason") == "already_archived":
            break

    if int(current_data.get("current_round") or 0) < target_round and not current_data.get("entries"):
        current_data["current_round"] = target_round
        current_data["status"] = "open"
        current_data["frozen_at"] = None
        _save_current_raw(current_data)
        current_data = _load_current_raw()
    return current_data


def _current_rule_snapshot(current_data: Dict[str, Any], summary: Dict[str, Any]) -> Dict[str, Any]:
    combo = summary.get("accumulated_combo_patterns") or {}
    verification = combo.get("combo_verification") or {}
    review_reference = get_photo_review_template().get("marked_numbers") or []
    return {
        "engine": "photo_analysis_current_round",
        "generated_at": summary.get("generated_at"),
        "round_no": summary.get("round_no"),
        "reference_source": "historical_review_template",
        "review_reference_count": len(review_reference),
        "analysis_mode": combo.get("analysis_mode"),
        "min_repeat": combo.get("min_repeat"),
        "criteria": verification.get("criteria"),
    }


def _refresh_current_dataset(current_data: Dict[str, Any]) -> None:
    summary = _current_dataset_summary(current_data)
    current_data.setdefault("derived_datasets", {})
    current_data.setdefault("rule_snapshots", {})
    current_data["derived_datasets"]["photo_analysis_current_round"] = summary
    current_data["rule_snapshots"]["photo_analysis_current_round"] = _current_rule_snapshot(
        current_data,
        summary,
    )


@_synchronized
def record_current_rule_engine_output(
    engine_name: str,
    *,
    round_no: int,
    latest_round: int,
    payload: Dict[str, Any],
    rule_snapshot: Dict[str, Any],
) -> bool:
    """현재회차 전용 파생 데이터와 규칙 스냅숏을 샌드박스에만 기록."""
    current_data = _load_current_raw()
    if current_data.get("entries") and int(current_data.get("current_round") or 0) != int(round_no):
        return False
    if not current_data.get("entries"):
        current_data["current_round"] = int(round_no)
    current_data.setdefault("derived_datasets", {})
    current_data.setdefault("rule_snapshots", {})
    current_data["status"] = "open"
    current_data["derived_datasets"][engine_name] = {
        "engine": engine_name,
        "round_no": int(round_no),
        "latest_round": int(latest_round),
        "generated_at": _now_iso(),
        "payload": _deep_copy(payload),
    }
    current_data["rule_snapshots"][engine_name] = {
        "engine": engine_name,
        "round_no": int(round_no),
        "latest_round": int(latest_round),
        "generated_at": _now_iso(),
        "rules": _deep_copy(rule_snapshot),
    }
    _save_current_raw(current_data)
    return True


def _entry_combo_patterns(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    combo = entry.get("combo_patterns")
    if combo:
        return combo
    r = entry.get("result") or {}
    evp = r.get("extracted_visual_patterns") or {}
    return evp.get("combo_patterns") or (r.get("meta") or {}).get("combo_patterns")


def _entry_position_template(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    tpl = entry.get("position_template")
    if tpl:
        return tpl
    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    evp = r.get("extracted_visual_patterns") or {}
    return meta.get("position_template") or evp.get("position_template")


def _dedupe_entries_by_content(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """내용 지문(content_fingerprint)이 같은 엔트리 중복 제거 — 최신(뒤) 것만 유지.

    같은 줄 묶음을 (회차·순서 흔들려도) 두 번 저장했을 때 통계가 2배로
    부풀던 문제를 자기치유한다. 내용 지문이 없는(약신호) 엔트리는 고유키로
    취급해 절대 병합하지 않는다(오병합 방지)."""
    from .dedup import _entry_content_fingerprint

    last_idx: Dict[str, int] = {}
    for i, e in enumerate(entries):
        cfp = e.get("content_fingerprint") or _entry_content_fingerprint(e)
        key = cfp if cfp else f"__uid_{e.get('id') or i}"
        last_idx[key] = i
    keep = set(last_idx.values())
    return [e for i, e in enumerate(entries) if i in keep]


def _dedupe_sheet_sets(sheet_sets: List[set[int]]) -> List[set[int]]:
    """동일 표시번호 용지는 1장만 집계."""
    seen: set[frozenset[int]] = set()
    out: List[set[int]] = []
    for raw in sheet_sets:
        key = frozenset(raw)
        if key in seen:
            continue
        seen.add(key)
        out.append(raw)
    return out


def _collect_deduped_sheet_sets(entries: List[Dict[str, Any]]) -> List[set[int]]:
    all_sets: List[set[int]] = []
    for entry in entries:
        all_sets.extend(_entry_sheet_sets(entry))
    return _dedupe_sheet_sets(all_sets)


def _sheet_detail_content_key(detail: Dict[str, Any]) -> tuple:
    """용지(줄 구성) 내용 키 — 줄별 정렬번호 튜플의 정렬 묶음."""
    lines = detail.get("lines") or []
    if lines:
        line_keys = sorted(
            tuple(sorted(int(n) for n in (ln.get("numbers") or []) if 1 <= int(n) <= 45))
            for ln in lines
        )
        return tuple(line_keys)
    nums = tuple(sorted(int(n) for n in (detail.get("numbers") or []) if 1 <= int(n) <= 45))
    return (nums,)


def _dedupe_sheet_details(details: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """엔트리 간 동일 용지(줄 구성) 1장만 — 교차줄 겹침 카운트 중복 방지.

    extract_betting_lines 는 details 의 위치(sheet_index)로 line_id 를 만들기 때문에,
    같은 용지가 여러 엔트리에 들어오면 서로 다른 line_id 로 두 번 집계된다.
    누적 재계산 전에 내용 기준으로 무중복화한다 (_collect_deduped_sheet_sets 와 동일 의도).
    """
    seen: set[tuple] = set()
    out: List[Dict[str, Any]] = []
    for d in details:
        key = _sheet_detail_content_key(d)
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def _entry_sheet_details(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    details = meta.get("sheet_details")
    if isinstance(details, list) and details:
        return details
    per_sheet = meta.get("sheet_number_sets") or []
    legacy: List[Dict[str, Any]] = []
    for raw in per_sheet:
        try:
            nums = [int(n) for n in raw if 1 <= int(n) <= 45]
        except (TypeError, ValueError):
            continue
        if len(nums) >= 2:
            legacy.append({"numbers": nums, "mark_scores": {}})
    return legacy


def _entry_sheet_sets(entry: Dict[str, Any]) -> List[set[int]]:
    """엔트리에서 용지별 표시 번호 집합 추출 (표시 강도 우선)."""
    from .combo_patterns import sheet_sets_from_details

    details = _entry_sheet_details(entry)
    if details:
        sets = sheet_sets_from_details(details, None)
        if sets:
            return sets

    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    sets: List[set[int]] = []
    per_sheet = meta.get("sheet_number_sets")
    if isinstance(per_sheet, list):
        for raw in per_sheet:
            try:
                nums = {int(n) for n in raw if 1 <= int(n) <= 45}
                if len(nums) >= 2:
                    sets.append(nums)
            except (TypeError, ValueError):
                pass
    if sets:
        return sets

    tpl = _entry_position_template(entry)
    if tpl and tpl.get("marked_numbers"):
        nums = {int(n) for n in tpl["marked_numbers"] if 1 <= int(n) <= 45}
        if len(nums) >= 2:
            sets.append(nums)

    fp = r.get("final_predictions") or {}
    fallback = {int(n) for n in fp.get("strong_candidates") or [] if 1 <= int(n) <= 45}
    if len(fallback) >= 2:
        sets.append(fallback)
    return sets


def _is_legacy_entry(entry: Dict[str, Any]) -> bool:
    return not (_entry_combo_patterns(entry) or _entry_position_template(entry))


def _merge_winning_combo_hits(combos: List[Dict[str, Any]]) -> Dict[str, Any]:
    """엔트리별 당첨 조합 일치 결과를 병합 (일반 용지 조합 폭발 방지)."""
    pair_best: Dict[tuple[int, ...], Dict[str, Any]] = {}
    triple_best: Dict[tuple[int, ...], Dict[str, Any]] = {}

    for combo in combos:
        if not combo:
            continue
        for bucket, store, size, label in (
            ("pair_duplicates", pair_best, 2, "당첨2번호"),
            ("triple_duplicates", triple_best, 3, "당첨3번호"),
        ):
            for item in combo.get(bucket) or []:
                try:
                    key = tuple(sorted(int(n) for n in item["numbers"]))
                    cnt = int(item.get("repeat_count", 1))
                except (TypeError, ValueError, KeyError):
                    continue
                prev = store.get(key)
                if not prev or cnt > int(prev.get("repeat_count", 0)):
                    store[key] = {
                        "numbers": list(key),
                        "size": size,
                        "repeat_count": cnt,
                        "label": label,
                        "is_winning_combo": True,
                    }

    pairs = sorted(pair_best.values(), key=lambda x: (-x["repeat_count"], x["numbers"]))
    triples = sorted(triple_best.values(), key=lambda x: (-x["repeat_count"], x["numbers"]))
    parts: List[str] = []
    if pairs:
        parts.append(f"당첨2번호 {len(pairs)}건")
    if triples:
        parts.append(f"당첨3번호 {len(triples)}건")
    return {
        "summary": " · ".join(parts) if parts else "당첨번호 2·3조합 일치 없음",
        "sheet_count": 0,
        "min_repeat": 1,
        "pair_duplicates": pairs,
        "triple_duplicates": triples,
    }


def _accumulate_combo_patterns(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """복기=당첨번호 조합, 이번회차=복기 사진 패턴 조합 (의도별 분리)."""
    from .draw_template import _winning_combo_hits, build_draw_review_template

    review_entries = [e for e in entries if e.get("video_intent") == "review"]
    current_entries = [e for e in entries if e.get("video_intent") == "current_round"]
    merged_parts: List[Dict[str, Any]] = []
    summary_bits: List[str] = []

    review_details: List[Dict[str, Any]] = []
    for entry in review_entries:
        review_details.extend(_entry_sheet_details(entry))
    review_sheets = _collect_deduped_sheet_sets(review_entries)
    if review_details or review_sheets:
        official = build_draw_review_template()
        review_out = _winning_combo_hits(
            official.get("winning_numbers") or [],
            review_sheets,
            sheet_details=review_details or None,
            bonus=official.get("bonus"),
        )
        review_out["summary"] = f"복기 당첨조합 · {review_out.get('summary', '')}"
        merged_parts.append(review_out)
        summary_bits.append(f"복기용지 {len(review_sheets)}장")

    current_details: List[Dict[str, Any]] = []
    for entry in current_entries:
        current_details.extend(_entry_sheet_details(entry))
    current_sheets = _collect_deduped_sheet_sets(current_entries)
    if current_details or current_sheets:
        from .combo_patterns import analyze_current_round_sheet_combos

        review_ref = []  # 이번회차: 복기 기준번호 참조 금지 (데이터 격리)
        current_out = analyze_current_round_sheet_combos(
            sheet_details=current_details or None,
            sheet_number_sets=current_sheets if not current_details else None,
            reference_numbers=review_ref,
        )
        merged_parts.append(current_out)
        summary_bits.append(f"이번용지 {len(current_sheets)}장")
    elif current_entries:
        stored = [_entry_combo_patterns(e) for e in current_entries]
        stored = [c for c in stored if c and (c.get("pair_duplicates") or c.get("triple_duplicates"))]
        if stored:
            merged_parts.append(_merge_winning_combo_hits(stored))

    if not merged_parts:
        return _winning_combo_hits(build_draw_review_template().get("winning_numbers") or [], [])

    if len(merged_parts) == 1:
        out = merged_parts[0]
        out["summary"] = f"{' · '.join(summary_bits)} · {out.get('summary', '')}".strip(" · ")
        return out

    pair_all: List[Dict[str, Any]] = []
    triple_all: List[Dict[str, Any]] = []
    for part in merged_parts:
        pair_all.extend(part.get("pair_duplicates") or [])
        triple_all.extend(part.get("triple_duplicates") or [])
    out = {
        "summary": " · ".join(summary_bits + [p.get("summary", "") for p in merged_parts if p.get("summary")]),
        "sheet_count": len(review_sheets) + len(current_sheets),
        "min_repeat": 1,
        "pair_duplicates": pair_all,
        "triple_duplicates": triple_all,
    }
    return out


def _entry_photo_review_template(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    """복기 사진 OCR 기반 템플릿 (당첨번호 공식 템플릿 제외)."""
    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    evp = r.get("extracted_visual_patterns") or {}
    for key in ("photo_review_template",):
        tpl = meta.get(key) or evp.get(key)
        if tpl and tpl.get("marked_numbers") and tpl.get("source") != "official_draw":
            return tpl

    tpl = entry.get("position_template")
    if tpl and tpl.get("source") == "official_draw":
        tpl = None
    if tpl and tpl.get("marked_numbers"):
        return tpl

    sheet_sets = _entry_sheet_sets(entry)
    if not sheet_sets:
        return None
    all_nums: set[int] = set()
    for s in sheet_sets:
        all_nums |= s
    if len(all_nums) < 2:
        return None
    return build_sheet_template(
        numbers=all_nums,
        positions={},
        ticket_round=entry.get("ticket_round"),
        intent="review",
    )


def get_saved_review_templates(limit: int = 20) -> List[Dict[str, Any]]:
    """저장된 복기 용지(사진 OCR) 템플릿."""
    data = _load_historical_raw()
    out: List[Dict[str, Any]] = []
    for entry in reversed(data.get("entries") or []):
        if entry.get("video_intent") != "review":
            continue
        tpl = _entry_photo_review_template(entry)
        if tpl:
            out.append(tpl)
            if len(out) >= limit:
                break
    return out


def get_photo_review_template() -> Dict[str, Any]:
    """이번회차 적용용 — 복기 사진에서 읽은 패턴만."""
    return merge_review_templates(get_saved_review_templates())


def get_merged_review_template() -> Dict[str, Any]:
    """누적 UI용 — 사진 복기 템플릿 + 당첨번호 참고."""
    from .draw_template import build_draw_review_template

    photo = get_photo_review_template()
    official = build_draw_review_template()
    if not photo.get("marked_numbers"):
        return official
    photo["official_draw_reference"] = official
    return photo


def _evaluate_combo_payload(payload: Dict[str, Any], winning_numbers: List[int], bonus: int) -> Dict[str, Any]:
    winning_set = set(winning_numbers)
    combos = payload.get("combinations") or []
    hit_distribution: Dict[str, int] = {}
    best_hit = 0
    bonus_hits = 0
    for combo in combos:
        nums = combo.get("numbers") if isinstance(combo, dict) else None
        if not isinstance(nums, list):
            continue
        hit_count = sum(1 for n in nums if n in winning_set)
        bonus_hit = bonus in nums
        best_hit = max(best_hit, hit_count)
        bonus_hits += 1 if bonus_hit else 0
        key = f"{hit_count}+{'b' if bonus_hit else '-'}"
        hit_distribution[key] = hit_distribution.get(key, 0) + 1
    return {
        "combo_count": len(combos),
        "best_hit": best_hit,
        "bonus_hits": bonus_hits,
        "hit_distribution": hit_distribution,
    }


def _evaluate_predictions_payload(payload: Dict[str, Any], winning_numbers: List[int], bonus: int) -> Dict[str, Any]:
    predictions = payload.get("final_predictions") or {}
    winning_set = set(winning_numbers)
    strong = [int(n) for n in predictions.get("strong_candidates") or []]
    excluded = [int(n) for n in predictions.get("excluded_candidates") or []]
    return {
        "strong_hits": [n for n in strong if n in winning_set],
        "excluded_hits": [n for n in excluded if n in winning_set],
        "bonus_in_strong": bonus in strong,
        "bonus_in_excluded": bonus in excluded,
    }


def _evaluate_current_dataset(current_data: Dict[str, Any], winning_numbers: List[int], bonus: int) -> Dict[str, Any]:
    evaluations: Dict[str, Any] = {}
    for key, dataset in (current_data.get("derived_datasets") or {}).items():
        payload = dataset.get("payload") if isinstance(dataset, dict) else None
        if not isinstance(payload, dict):
            payload = dataset if isinstance(dataset, dict) else {}
        result: Dict[str, Any] = {}
        if isinstance(payload.get("combinations"), list):
            result.update(_evaluate_combo_payload(payload, winning_numbers, bonus))
        if isinstance(payload.get("final_predictions"), dict):
            result.update(_evaluate_predictions_payload(payload, winning_numbers, bonus))
        evaluations[key] = result
    return evaluations


@_synchronized
def rollover_current_dataset(
    *,
    drawn_round: int,
    next_round: int,
    winning_numbers: List[int],
    bonus: int,
) -> Dict[str, Any]:
    """현재회차 샌드박스를 동결하고 historical 아카이브로 원자적으로 이관."""
    historical = _load_historical_raw()
    current = _load_current_raw()
    archived = historical.get("archived_current_rounds") or []
    if any(int(batch.get("round_no") or 0) == int(drawn_round) for batch in archived):
        if int(current.get("current_round") or 0) != int(next_round):
            current = _empty_current_raw(next_round)
            _save_current_raw(current)
        return {"ok": True, "rolled_over": False, "reason": "already_archived"}
    if int(current.get("current_round") or 0) != int(drawn_round):
        return {"ok": True, "rolled_over": False, "reason": "no_matching_current_round"}

    entries = list(current.get("entries") or [])
    for entry in entries:
        if entry.get("video_intent") != "current_round":
            return {"ok": False, "error": "현재회차 샌드박스에 비현재회차 데이터가 섞여 있습니다."}
        if str(_entry_round(entry)) != str(drawn_round):
            return {"ok": False, "error": "현재회차 샌드박스 엔트리의 회차가 일치하지 않습니다."}
    if int(next_round) != int(drawn_round) + 1:
        return {"ok": False, "error": "회차 시퀀스가 연속적이지 않습니다."}
    if any(
        entry.get("video_intent") == "current_round" and str(_entry_round(entry)) == str(drawn_round)
        for entry in historical.get("entries") or []
    ):
        return {"ok": False, "error": "현재회차 임시 데이터가 historical review 저장소에 유출되어 있습니다."}

    previous_historical = _deep_copy(historical)
    previous_current = _deep_copy(current)
    frozen_at = _now_iso()
    current["status"] = "frozen"
    current["frozen_at"] = frozen_at
    backtest = {
        "round_no": int(drawn_round),
        "winning_numbers": list(winning_numbers),
        "bonus": int(bonus),
        "engine_results": _evaluate_current_dataset(current, winning_numbers, bonus),
    }
    archive_batch = {
        "round_no": int(drawn_round),
        "frozen_at": frozen_at,
        "merged_at": _now_iso(),
        "entries": _deep_copy(entries),
        "derived_datasets": _deep_copy(current.get("derived_datasets") or {}),
        "rule_snapshots": _deep_copy(current.get("rule_snapshots") or {}),
        "backtest": backtest,
    }

    try:
        historical.setdefault("archived_current_rounds", [])
        historical["archived_current_rounds"].append(archive_batch)
        _save_historical_raw(historical)
        _save_current_raw(_empty_current_raw(next_round))
    except Exception:
        _save_historical_raw(previous_historical)
        _save_current_raw(previous_current)
        raise

    return {
        "ok": True,
        "rolled_over": True,
        "archived_round": int(drawn_round),
        "next_round": int(next_round),
        "entry_count": len(entries),
    }


def get_current_dataset_state() -> Dict[str, Any]:
    return _load_current_raw()


def get_historical_dataset_state() -> Dict[str, Any]:
    return _load_historical_raw()


def _latest_archived_current_snapshot(historical: Dict[str, Any]) -> Dict[str, Any] | None:
    batches = historical.get("archived_current_rounds") or []
    if not batches:
        return None
    batch = batches[-1]
    entries = list(batch.get("entries") or [])
    derived = batch.get("derived_datasets") or {}
    photo_summary = derived.get("photo_analysis_current_round") or {}
    final_predictions = photo_summary.get("final_predictions") or (
        _accumulate_entries(entries).get("final_predictions") if entries else {
            "strong_candidates": [],
            "excluded_candidates": [],
        }
    )
    combo_patterns = photo_summary.get("accumulated_combo_patterns") or (
        _recompute_intent_combo(entries, "current_round")
        if entries
        else {"summary": "분석 없음", "pair_duplicates": [], "triple_duplicates": []}
    )
    round_no = int(batch.get("round_no") or 0)
    return {
        "archived": True,
        "ticket_round": str(round_no) if round_no > 0 else None,
        "round_no": round_no,
        "total_analyses": len(entries),
        "final_predictions": final_predictions,
        "accumulated_combo_patterns": combo_patterns,
        "entries_summary": _entries_summary_for(entries),
        "app_ui_message": (
            f"보관된 이번회차 {len(entries)}건 · {round_no}회 백테스트 보관본"
            if round_no > 0
            else f"보관된 이번회차 {len(entries)}건"
        ),
        "frozen_at": batch.get("frozen_at"),
        "merged_at": batch.get("merged_at"),
        "backtest": batch.get("backtest") or {},
    }


def list_entries(limit: int = 100) -> List[Dict[str, Any]]:
    return list(reversed(_live_entries()[-limit:]))


@_synchronized
def clear_store() -> int:
    historical = _load_historical_raw()
    current = _load_current_raw()
    count = (
        len(historical.get("entries") or [])
        + len(_archived_current_entries(historical))
        + len(current.get("entries") or [])
    )
    _save_historical_raw(_empty_historical_raw())
    _save_current_raw(_empty_current_raw())
    return count


@_synchronized
def clear_store_intent(intent: str) -> int:
    """특정 intent 에 해당하는 저장소만 비운다."""
    if intent == "review":
        historical = _load_historical_raw()
        kept_entries = [e for e in historical.get("entries") or [] if e.get("video_intent") != "review"]
        removed = len(historical.get("entries") or []) - len(kept_entries)
        historical["entries"] = kept_entries
        _save_historical_raw(historical)
        return removed

    if intent == "current_round":
        current = _load_current_raw()
        removed = len(current.get("entries") or [])
        current["entries"] = []
        current["derived_datasets"] = {}
        current["rule_snapshots"] = {}
        current["status"] = "open"
        current["frozen_at"] = None
        _save_current_raw(current)
        return removed

    raise ValueError("intent must be 'review' or 'current_round'")


@_synchronized
def reclassify_manual_pick_type(
    intent: str, from_pick_type: str, to_pick_type: str
) -> int:
    """특정 intent 의 수기 엔트리 픽 타입을 일괄 재분류한다.

    구 버전(픽 타입 도입 전)에 저장돼 전부 '반자동'으로 갇힌 자동 구매 용지를
    '자동'으로 되돌리는 등, 레거시 데이터 정정에 쓴다. pick_type 필드만 수정하며
    번호·구조는 절대 건드리지 않는다.
    """
    if intent not in ("review", "current_round"):
        raise ValueError("intent must be 'review' or 'current_round'")
    from_pt = (from_pick_type or "").strip()
    to_pt = (to_pick_type or "").strip()
    if to_pt not in ("자동", "반자동"):
        raise ValueError("to_pick_type must be '자동' or '반자동'")

    def _is_manual(e: Dict[str, Any]) -> bool:
        if str(e.get("entry_mode") or "") == "manual":
            return True
        return str(((e.get("result") or {}).get("meta") or {}).get("entry_mode") or "") == "manual"

    def _apply(entries: List[Dict[str, Any]]) -> int:
        changed = 0
        for e in entries:
            if not _is_manual(e):
                continue
            if str(e.get("video_intent") or "") != intent:
                continue
            if from_pt and _entry_pick_type(e) != from_pt:
                continue
            e["pick_type"] = to_pt
            res = e.get("result")
            if isinstance(res, dict):
                meta = res.get("meta")
                if isinstance(meta, dict):
                    meta["pick_type"] = to_pt
                    for sd in meta.get("sheet_details") or []:
                        if isinstance(sd, dict):
                            sd["pick_type"] = to_pt
            changed += 1
        return changed

    if intent == "review":
        historical = _load_historical_raw()
        changed = _apply(historical.get("entries") or [])
        if changed:
            _save_historical_raw(historical)
        return changed

    current = _load_current_raw()
    changed = _apply(current.get("entries") or [])
    if changed:
        _refresh_current_dataset(current)
        _save_current_raw(current)
    return changed


@_synchronized
def delete_entry(entry_id: str) -> bool:
    historical = _load_historical_raw()
    entries = historical.get("entries") or []
    new_entries = [e for e in entries if e.get("id") != entry_id]
    if len(new_entries) != len(entries):
        historical["entries"] = new_entries
        _save_historical_raw(historical)
        return True

    current = _load_current_raw()
    current_entries = current.get("entries") or []
    new_current_entries = [e for e in current_entries if e.get("id") != entry_id]
    if len(new_current_entries) == len(current_entries):
        return False
    current["entries"] = new_current_entries
    _refresh_current_dataset(current)
    _save_current_raw(current)
    return True


def _vote_list(counter: Counter, limit: int = 20) -> List[Dict[str, Any]]:
    return [{"number": n, "votes": c, "video_count": c} for n, c in counter.most_common(limit)]


def _accumulate_entries(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    strong_votes: Counter = Counter()
    excluded_votes: Counter = Counter()
    multiples_votes: Counter = Counter()
    line_votes: Counter = Counter()
    line_types: Dict[int, Counter] = {}

    for entry in entries:
        r = entry.get("result") or entry
        fp = r.get("final_predictions") or {}
        evp = r.get("extracted_visual_patterns") or {}

        for n in fp.get("strong_candidates") or []:
            try:
                strong_votes[int(n)] += 1
            except (TypeError, ValueError):
                pass
        for n in fp.get("excluded_candidates") or []:
            try:
                excluded_votes[int(n)] += 1
            except (TypeError, ValueError):
                pass
        for n in (evp.get("identified_multiples") or {}).get("numbers") or []:
            try:
                multiples_votes[int(n)] += 1
            except (TypeError, ValueError):
                pass
        for lp in evp.get("line_patterns") or []:
            try:
                tn = int(lp.get("target_number"))
                line_votes[tn] += 1
                line_types.setdefault(tn, Counter())[str(lp.get("pattern_type") or "line")] += 1
            except (TypeError, ValueError):
                pass

    freq_acc = accumulate_frequency_patterns(entries)
    line_patterns = []
    for n, c in line_votes.most_common(20):
        ptype = line_types.get(n, Counter()).most_common(1)
        line_patterns.append(
            {"target_number": n, "votes": c, "pattern_type": ptype[0][0] if ptype else "line"}
        )

    multiples_top = _vote_list(multiples_votes, 15)
    return {
        "strong_candidate_votes": _vote_list(strong_votes),
        "excluded_candidate_votes": _vote_list(excluded_votes),
        "multiples_votes": multiples_top,
        "identified_multiples": {
            "type": "쌍수" if multiples_votes else "중복없음",
            "numbers": [x["number"] for x in multiples_top],
        },
        "frequency_overlap_patterns": freq_acc,
        "triple_plus_overlap": freq_acc["triple_plus_overlap"],
        "line_pattern_votes": line_patterns,
        "final_predictions": {
            "strong_candidates": [n for n, _ in strong_votes.most_common(18)],
            "excluded_candidates": [n for n, _ in excluded_votes.most_common(12)],
        },
    }


def _entries_summary_for(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            "id": e.get("id"),
            "url": e.get("url"),
            "video_id": e.get("video_id"),
            "video_title": e.get("video_title"),
            "ticket_round": _entry_round(e),
            "ticket_round_confidence": e.get("ticket_round_confidence"),
            "video_intent": e.get("video_intent"),
            "video_intent_label": e.get("video_intent_label"),
            "referenced_rounds": e.get("referenced_rounds") or [],
            "analyzed_at": e.get("analyzed_at"),
            "strong_candidates": (
                (e.get("result") or {}).get("final_predictions") or {}
            ).get("strong_candidates") or [],
            "frequency_overlap_patterns": e.get("frequency_overlap_patterns")
            or ((e.get("result") or {}).get("extracted_visual_patterns") or {}).get(
                "frequency_overlap_patterns"
            ),
            "triple_plus_overlap": (e.get("triple_plus_overlap") or {}).get("items") or [],
            "ticket_fingerprint": e.get("ticket_fingerprint"),
        }
        for e in reversed(entries)
    ]


def _latest_entry_combo(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    combo = _entry_combo_patterns(entry)
    if combo and combo.get("combo_verification"):
        return combo
    r = entry.get("result") or {}
    evp = r.get("extracted_visual_patterns") or {}
    meta = r.get("meta") or {}
    return evp.get("combo_patterns") or meta.get("combo_patterns") or combo


def _recompute_intent_combo(entries: List[Dict[str, Any]], intent: str) -> Dict[str, Any]:
    from .combo_patterns import analyze_current_round_sheet_combos
    from .draw_template import _winning_combo_hits, build_draw_review_template

    group = [e for e in entries if e.get("video_intent") == intent]
    if not group:
        return {"summary": "분석 없음", "pair_duplicates": [], "triple_duplicates": []}

    # 라이브 재계산 강제 — 이전엔 latest entry 의 stored combo 를 그대로
    # 반환하여 옛 cap 데이터 (pair 10건 / triple 15건) 가 by_intent
    # 슬라이스에 박혀 있었음. 사용자가 모든 항목을 보고 싶다고 명시하여
    # stored 단락 제거하고 항상 모든 entry 의 raw sheet details 에서
    # 라이브 재계산. 다소 느릴 수 있으나 (수십 ms ~ 수백 ms) 정확도 보장.

    if intent == "review":
        details: List[Dict[str, Any]] = []
        for entry in group:
            details.extend(_entry_sheet_details(entry))
        details = _dedupe_sheet_details(details)
        sheets = _collect_deduped_sheet_sets(group)
        official = build_draw_review_template()
        out = _winning_combo_hits(
            official.get("winning_numbers") or [],
            sheets,
            sheet_details=details or None,
            bonus=official.get("bonus"),
        )
        out["summary"] = f"복기 당첨조합 · {out.get('summary', '')}"
        return out

    details = []
    for entry in group:
        details.extend(_entry_sheet_details(entry))
    details = _dedupe_sheet_details(details)
    sheets = _collect_deduped_sheet_sets(group)
    review_ref: list[int] = []  # 복기 템플릿 미참조 — 이번회차 저장분 줄간 겹침만
    return analyze_current_round_sheet_combos(
        sheet_details=details or None,
        sheet_number_sets=sheets if not details else None,
        reference_numbers=review_ref,
    )


def _manual_saved_lines(
    group: List[Dict[str, Any]], want_pick_type: str = "반자동"
) -> List[List[int]]:
    """수기/대량 엔트리의 게임 줄(번호배열) 목록 — 기기 간 동기화용.
    want_pick_type(자동/반자동) 으로 필터해 프론트 자동·반자동 누적을 각각 복원한다."""
    from .line_overlap_patterns import extract_betting_lines

    def _is_manual(e: Dict[str, Any]) -> bool:
        if str(e.get("entry_mode") or "") == "manual":
            return True
        return str(((e.get("result") or {}).get("meta") or {}).get("entry_mode") or "") == "manual"

    details: List[Dict[str, Any]] = []
    for e in group:
        if _is_manual(e) and _entry_pick_type(e) == want_pick_type:
            details.extend(_entry_sheet_details(e))
    if not details:
        return []
    details = _dedupe_sheet_details(details)
    lines = extract_betting_lines(details)
    out: List[List[int]] = []
    for ln in lines:
        nums = [int(n) for n in (ln.get("numbers") or []) if 1 <= int(n) <= 45]
        if len(nums) >= 2:
            out.append(sorted(nums))
    return out


def _build_intent_slice(entries: List[Dict[str, Any]], intent: str) -> Dict[str, Any]:
    """복기 / 이번회차 탭별 누적 데이터."""
    from .draw_template import build_draw_review_template, get_review_round_no, get_current_round_no

    group = [e for e in entries if e.get("video_intent") == intent]
    label = "복기" if intent == "review" else "이번회차"
    round_no = str(get_review_round_no()) if intent == "review" else str(get_current_round_no())
    intent_acc = _accumulate_entries(group) if group else None
    combo = _recompute_intent_combo(entries, intent) if group else {
        "summary": f"{label} 분석 없음",
        "pair_duplicates": [],
        "triple_duplicates": [],
    }
    parts: List[str] = [f"{label} {len(group)}건"]
    if group:
        parts.append(f"{round_no}회")
    if combo.get("pair_duplicates") or combo.get("triple_duplicates"):
        parts.append(combo.get("summary", ""))

    slice_fp = (intent_acc or {}).get("final_predictions") or {
        "strong_candidates": [],
        "excluded_candidates": [],
    }
    combo_strong = combo.get("strong_candidates") or []
    if combo_strong:
        merged_strong = list(dict.fromkeys(combo_strong + (slice_fp.get("strong_candidates") or [])))
        slice_fp = {**slice_fp, "strong_candidates": merged_strong[:18]}

    slice_out: Dict[str, Any] = {
        "video_intent": intent,
        "video_intent_label": label,
        "ticket_round": round_no,
        "total_analyses": len(group),
        "accumulated_combo_patterns": combo,
        "final_predictions": slice_fp,
        "entries_summary": _entries_summary_for(group),
        "saved_semi_lines": _manual_saved_lines(group, "반자동"),  # 반자동 복원용
        "saved_auto_lines": _manual_saved_lines(group, "자동"),    # 자동 복원용
        "app_ui_message": " · ".join(p for p in parts if p),
    }
    if intent == "review":
        official = build_draw_review_template()
        photo = get_photo_review_template()
        slice_out["draw_template"] = official
        slice_out["saved_review_template"] = photo if photo.get("marked_numbers") else None
    else:
        # 이번회차: 복기 saved_review_template 노출·참조 금지
        slice_out["saved_review_template"] = None
        slice_out["pattern_ready"] = len(group) > 0
    return slice_out


def build_accumulated() -> Dict[str, Any]:
    historical = _load_historical_raw()
    current = _load_current_raw()
    entries: List[Dict[str, Any]] = _live_entries()
    archived_current_snapshot = _latest_archived_current_snapshot(historical)
    overall = _accumulate_entries(entries)

    by_round: Dict[str, Any] = {}
    by_intent: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    round_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for entry in entries:
        rnd = _entry_round(entry)
        round_groups[rnd].append(entry)
        by_intent[entry.get("video_intent") or "unknown"].append(entry)

    for rnd, group in round_groups.items():
        acc = _accumulate_entries(group)
        intents = Counter(e.get("video_intent") or "unknown" for e in group)
        by_round[rnd] = {
            "ticket_round": rnd,
            "analysis_count": len(group),
            "dominant_intent": intents.most_common(1)[0][0] if intents else "unknown",
            "dominant_intent_label": next(
                (e.get("video_intent_label") for e in reversed(group) if e.get("video_intent_label")),
                None,
            ),
            **acc,
        }

    unique_ids = {e.get("video_id") for e in entries if e.get("video_id")}
    accumulated_combo = _accumulate_combo_patterns(entries)
    legacy_count = sum(1 for e in entries if _is_legacy_entry(e))
    review_template = get_merged_review_template()
    if review_template.get("marked_numbers") and not review_template.get("combo_patterns"):
        review_template["combo_patterns"] = _accumulate_combo_patterns(
            [e for e in entries if e.get("video_intent") == "review"]
        )

    ui_parts: List[str] = []
    if entries:
        ui_parts.append(f"누적 {len(entries)}건")
    if by_round:
        rounds_sorted = sorted(
            (k for k in by_round if k != "미확인"),
            key=lambda x: int(x) if x.isdigit() else 0,
            reverse=True,
        )
        if rounds_sorted:
            ui_parts.append(f"회차 {', '.join(f'{r}회' for r in rounds_sorted[:4])}")
    deduped_sheets = len(_collect_deduped_sheet_sets(entries))
    if deduped_sheets:
        ui_parts.append(f"고유용지 {deduped_sheets}장")
    if accumulated_combo.get("pair_duplicates"):
        top = accumulated_combo["pair_duplicates"][0]
        ui_parts.append(f"당첨2조합 {top['numbers']} ×{top['repeat_count']}")
    if accumulated_combo.get("triple_duplicates"):
        top = accumulated_combo["triple_duplicates"][0]
        ui_parts.append(f"당첨3조합 {top['numbers']} ×{top['repeat_count']}")
    if review_template.get("marked_numbers"):
        ui_parts.append(f"복기저장 {len(review_template['marked_numbers'])}개")
    if legacy_count:
        ui_parts.append(f"구형데이터 {legacy_count}건(재분석 권장)")

    return {
        "total_analyses": len(entries),
        "unique_videos": len(unique_ids),
        "unique_photos": len(unique_ids),
        "updated_at": max(
            str(historical.get("updated_at") or ""),
            str(current.get("updated_at") or ""),
        ),
        "legacy_entry_count": legacy_count,
        "accumulated_combo_patterns": accumulated_combo,
        "saved_review_template": review_template if review_template.get("marked_numbers") else None,
        **overall,
        "historical_dataset": {
            "review_entries": len(historical.get("entries") or []),
            "archived_current_rounds": len(historical.get("archived_current_rounds") or []),
            "latest_archived_round": next(
                (
                    batch.get("round_no")
                    for batch in reversed(historical.get("archived_current_rounds") or [])
                    if batch.get("round_no") is not None
                ),
                None,
            ),
            "latest_archived_current_snapshot": archived_current_snapshot,
        },
        "current_dataset": {
            "round_no": int(current.get("current_round") or 0),
            "status": current.get("status") or "open",
            "entry_count": len(current.get("entries") or []),
            "derived_datasets": sorted((current.get("derived_datasets") or {}).keys()),
            "rule_snapshots": sorted((current.get("rule_snapshots") or {}).keys()),
            "frozen_at": current.get("frozen_at"),
        },
        "by_ticket_round": by_round,
        "by_video_intent": {
            k: {"count": len(v), "ticket_rounds": sorted({_entry_round(e) for e in v})}
            for k, v in by_intent.items()
        },
        "by_intent": {
            "review": _build_intent_slice(entries, "review"),
            "current_round": _build_intent_slice(entries, "current_round"),
        },
        "app_ui_message": " · ".join(ui_parts) if ui_parts else "저장된 분석이 없습니다.",
        "entries_summary": _entries_summary_for(entries),
    }
