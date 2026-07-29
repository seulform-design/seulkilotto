"""사람 승인 Model Registry — scoring_allowed 수동 비활성 아카이브.

삭제 금지·자동 mute 금지. POST 승인 시에만 disabled 목록에 추가.
경로: backend/data/model_registry_archive.json
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
ARCHIVE_PATH = DATA_DIR / "model_registry_archive.json"
_LOCK = threading.RLock()

HONESTY = (
    "사람 승인 비활성만 반영합니다. 자동 scoring 변경 없음. "
    "아카이브는 삭제하지 않고 누적합니다. 당첨 확률 불변."
)


def _empty() -> dict[str, Any]:
    return {
        "version": "0.1.0",
        "disabled": {},  # model_id -> {reason, at, by}
        "events": [],  # append-only
        "honesty": HONESTY,
    }


def _load() -> dict[str, Any]:
    if not ARCHIVE_PATH.is_file():
        return _empty()
    try:
        raw = json.loads(ARCHIVE_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return _empty()
        raw.setdefault("disabled", {})
        raw.setdefault("events", [])
        raw.setdefault("honesty", HONESTY)
        raw.setdefault("version", "0.1.0")
        return raw
    except (OSError, json.JSONDecodeError):
        return _empty()


def _save(data: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ARCHIVE_PATH.with_suffix(".tmp")
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(ARCHIVE_PATH)


def get_registry_state() -> dict[str, Any]:
    with _LOCK:
        data = _load()
    disabled = data.get("disabled") or {}
    return {
        "ok": True,
        "version": data.get("version", "0.1.0"),
        "disabled_ids": sorted(disabled.keys()),
        "disabled": disabled,
        "event_count": len(data.get("events") or []),
        "events": list(data.get("events") or [])[-30:],
        "auto_mutate_scoring": False,
        "honesty": HONESTY,
    }


def list_disabled_ids() -> set[str]:
    with _LOCK:
        data = _load()
    return set((data.get("disabled") or {}).keys())


def apply_disable(
    model_id: str,
    *,
    reason: str,
    confirmed: bool,
    by: str = "operator",
) -> dict[str, Any]:
    """사람 승인 비활성. confirmed=False 이면 거부. 기존 항목은 덮어쓰지 않고 events에 남김."""
    mid = str(model_id or "").strip()
    if not mid:
        return {"ok": False, "error": "model_id required", "auto_applied": False}
    if not confirmed:
        return {
            "ok": False,
            "error": "confirm=true 필요 — 자동 적용 금지",
            "auto_applied": False,
        }
    now = datetime.now(timezone.utc).isoformat()
    with _LOCK:
        data = _load()
        disabled = dict(data.get("disabled") or {})
        prev = disabled.get(mid)
        disabled[mid] = {
            "reason": str(reason or "human_disable")[:500],
            "at": now,
            "by": str(by or "operator")[:120],
            "previous": prev,
        }
        events = list(data.get("events") or [])
        events.append(
            {
                "action": "disable",
                "model_id": mid,
                "reason": disabled[mid]["reason"],
                "at": now,
                "by": disabled[mid]["by"],
            }
        )
        data["disabled"] = disabled
        data["events"] = events[-500:]
        _save(data)
    return {
        "ok": True,
        "model_id": mid,
        "action": "disable",
        "auto_applied": False,
        "requires_human": True,
        "state": get_registry_state(),
        "honesty": HONESTY,
    }


def apply_enable(
    model_id: str,
    *,
    confirmed: bool,
    by: str = "operator",
) -> dict[str, Any]:
    """비활성 해제. 이벤트는 유지(삭제 금지)."""
    mid = str(model_id or "").strip()
    if not mid:
        return {"ok": False, "error": "model_id required", "auto_applied": False}
    if not confirmed:
        return {
            "ok": False,
            "error": "confirm=true 필요 — 자동 적용 금지",
            "auto_applied": False,
        }
    now = datetime.now(timezone.utc).isoformat()
    with _LOCK:
        data = _load()
        disabled = dict(data.get("disabled") or {})
        if mid not in disabled:
            return {"ok": False, "error": "not_disabled", "model_id": mid, "auto_applied": False}
        removed = disabled.pop(mid)
        events = list(data.get("events") or [])
        events.append(
            {
                "action": "enable",
                "model_id": mid,
                "reason": f"re-enable (was: {removed.get('reason')})",
                "at": now,
                "by": str(by or "operator")[:120],
            }
        )
        data["disabled"] = disabled
        data["events"] = events[-500:]
        _save(data)
    return {
        "ok": True,
        "model_id": mid,
        "action": "enable",
        "auto_applied": False,
        "requires_human": True,
        "state": get_registry_state(),
        "honesty": HONESTY,
    }


def apply_human_disables_to_feature_reports(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """disabled feature:* / key 를 adopted=False 로 강제 (추천 경로 차단)."""
    disabled = list_disabled_ids()
    if not disabled or not reports:
        return reports
    out = []
    for r in reports:
        row = dict(r)
        key = str(row.get("key") or "")
        mid = key if key.startswith("feature:") else f"feature:{key}"
        if mid in disabled or key in disabled:
            row["adopted"] = False
            row["validation_passed"] = False
            row["human_disabled"] = True
            reasons = list(row.get("exclude_reason") or [])
            reasons = [f"사람 승인 비활성({mid})"] + [x for x in reasons if "사람 승인" not in str(x)]
            row["exclude_reason"] = reasons
            row["use_reason"] = []
        out.append(row)
    return out
