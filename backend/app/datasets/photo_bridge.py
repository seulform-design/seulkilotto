"""용지 분석 저장소 ↔ Current Sandbox 브리지."""
from __future__ import annotations

from typing import Any, Dict, List

from .current import SandboxFrozenError, get_current_sandbox


def _is_current_intent(entry: Dict[str, Any]) -> bool:
    return (entry.get("video_intent") or "") == "current_round"


def migrate_legacy_current_entries(legacy_entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """레거시 통합 JSON 의 current_round 항목을 샌드박스로 1회 이관."""
    sb = get_current_sandbox()
    if sb.list_photo_entries():
        return legacy_entries
    current_rows = [e for e in legacy_entries if _is_current_intent(e)]
    if not current_rows:
        return legacy_entries
    try:
        for row in current_rows:
            sb.append_photo_entry(row)
    except SandboxFrozenError:
        return legacy_entries
    return [e for e in legacy_entries if not _is_current_intent(e)]


def append_current_round_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    return get_current_sandbox().append_photo_entry(entry)


def list_merged_entries(legacy_entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    legacy_entries = migrate_legacy_current_entries(legacy_entries)
    sandbox_entries = get_current_sandbox().list_photo_entries()
    return legacy_entries + sandbox_entries


def delete_merged_entry(entry_id: str, legacy_entries: List[Dict[str, Any]]) -> tuple[bool, List[Dict[str, Any]]]:
    sb = get_current_sandbox()
    try:
        if sb.delete_photo_entry(entry_id):
            return True, legacy_entries
    except SandboxFrozenError:
        return False, legacy_entries
    new_legacy = [e for e in legacy_entries if e.get("id") != entry_id]
    if len(new_legacy) == len(legacy_entries):
        return False, legacy_entries
    return True, new_legacy


def clear_sandbox_photo_entries() -> int:
    try:
        return get_current_sandbox().clear_photo_entries()
    except SandboxFrozenError:
        return 0
