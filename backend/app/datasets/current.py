"""Current Dataset — ISOLATED SANDBOX (READ/WRITE).

진행 중인 N회차 전용: 용지분석·규칙 기반 추천 파생 데이터.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..data_meta import effective_current_round, get_history_meta
from .types import DerivedRecommendation, RuleSnapshot, SandboxState

_DATA_ROOT = Path(__file__).resolve().parents[2] / "data" / "datasets"
CURRENT_DIR = _DATA_ROOT / "current"
STATE_PATH = CURRENT_DIR / "sandbox_state.json"
PHOTO_PATH = CURRENT_DIR / "photo_entries.json"
DERIVED_PATH = CURRENT_DIR / "derived_recommendations.json"


class SandboxFrozenError(RuntimeError):
    """롤오버 동결 중 쓰기 시도."""


class SandboxRoundMismatchError(RuntimeError):
    """요청 회차와 샌드박스 회차 불일치."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> None:
    CURRENT_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class CurrentDrawSandbox:
    """최신 회차 격리 샌드박스."""

    def __init__(self) -> None:
        CURRENT_DIR.mkdir(parents=True, exist_ok=True)
        self._ensure_initialized()

    def _meta_current_round(self) -> int:
        meta = get_history_meta()
        latest = int(meta.get("latest_round") or 0)
        return effective_current_round(latest)

    def _ensure_initialized(self) -> SandboxState:
        state = self.get_state()
        expected = self._meta_current_round()
        if state.round_no != expected:
            return self._init_sandbox(expected)
        return state

    def get_state(self) -> SandboxState:
        raw = _read_json(STATE_PATH, {})
        if not raw:
            rnd = self._meta_current_round()
            return SandboxState(round_no=rnd)
        return SandboxState(
            round_no=int(raw.get("round_no") or self._meta_current_round()),
            frozen=bool(raw.get("frozen")),
            write_enabled=bool(raw.get("write_enabled", True)),
            frozen_at=raw.get("frozen_at"),
            initialized_at=str(raw.get("initialized_at") or _now_iso()),
        )

    def _save_state(self, state: SandboxState) -> None:
        _write_json(STATE_PATH, state.to_dict())

    def _init_sandbox(self, round_no: int) -> SandboxState:
        state = SandboxState(round_no=round_no, frozen=False, write_enabled=True)
        self._save_state(state)
        _write_json(PHOTO_PATH, {"version": 1, "round_no": round_no, "entries": []})
        _write_json(DERIVED_PATH, {"version": 1, "round_no": round_no, "runs": []})
        return state

    def assert_writable(self) -> None:
        state = self._ensure_initialized()
        if state.frozen or not state.write_enabled:
            raise SandboxFrozenError(
                f"Current sandbox (round {state.round_no}) is frozen — writes blocked until rollover completes"
            )

    def freeze(self) -> SandboxState:
        state = self.get_state()
        state.frozen = True
        state.write_enabled = False
        state.frozen_at = _now_iso()
        self._save_state(state)
        return state

    def unfreeze(self) -> SandboxState:
        """롤오버 실패 시 동결 해제 (병합 전 롤백)."""
        state = self.get_state()
        state.frozen = False
        state.write_enabled = True
        state.frozen_at = None
        self._save_state(state)
        return state

    def flush_and_init_next(self, next_round: int) -> SandboxState:
        return self._init_sandbox(next_round)

    def list_photo_entries(self) -> List[Dict[str, Any]]:
        data = _read_json(PHOTO_PATH, {"entries": []})
        return list(data.get("entries") or [])

    def append_photo_entry(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        self.assert_writable()
        state = self.get_state()
        data = _read_json(PHOTO_PATH, {"version": 1, "round_no": state.round_no, "entries": []})
        if int(data.get("round_no") or state.round_no) != state.round_no:
            raise SandboxRoundMismatchError("photo store round mismatch")
        out = dict(entry)
        out.setdefault("id", str(uuid.uuid4()))
        out.setdefault("sandbox_round", state.round_no)
        out.setdefault("analyzed_at", _now_iso())
        data["entries"].append(out)
        data["round_no"] = state.round_no
        data["updated_at"] = _now_iso()
        _write_json(PHOTO_PATH, data)
        return out

    def clear_photo_entries(self) -> int:
        self.assert_writable()
        state = self.get_state()
        entries = self.list_photo_entries()
        _write_json(PHOTO_PATH, {"version": 1, "round_no": state.round_no, "entries": [], "updated_at": _now_iso()})
        return len(entries)

    def delete_photo_entry(self, entry_id: str) -> bool:
        self.assert_writable()
        state = self.get_state()
        entries = self.list_photo_entries()
        remaining = [e for e in entries if e.get("id") != entry_id]
        if len(remaining) == len(entries):
            return False
        _write_json(
            PHOTO_PATH,
            {
                "version": 1,
                "round_no": state.round_no,
                "entries": remaining,
                "updated_at": _now_iso(),
            },
        )
        return True

    def list_derived_recommendations(self) -> List[Dict[str, Any]]:
        data = _read_json(DERIVED_PATH, {"runs": []})
        return list(data.get("runs") or [])

    def append_derived_recommendation(self, derived: DerivedRecommendation) -> Dict[str, Any]:
        self.assert_writable()
        state = self.get_state()
        if derived.round_no != state.round_no:
            raise SandboxRoundMismatchError(
                f"derived round {derived.round_no} != sandbox round {state.round_no}"
            )
        data = _read_json(DERIVED_PATH, {"version": 1, "round_no": state.round_no, "runs": []})
        payload = derived.to_dict()
        data["runs"].append(payload)
        data["round_no"] = state.round_no
        data["updated_at"] = _now_iso()
        _write_json(DERIVED_PATH, data)
        return payload

    def export_snapshot(self) -> Dict[str, Any]:
        """롤오버 STEP 1 동결 스냅숏."""
        state = self.get_state()
        return {
            "state": state.to_dict(),
            "photo_entries": self.list_photo_entries(),
            "derived_recommendations": self.list_derived_recommendations(),
        }


_sandbox_singleton: CurrentDrawSandbox | None = None


def get_current_sandbox() -> CurrentDrawSandbox:
    global _sandbox_singleton
    if _sandbox_singleton is None:
        _sandbox_singleton = CurrentDrawSandbox()
    return _sandbox_singleton
