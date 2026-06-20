"""데이터셋 격리 도메인 타입."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class RuleSnapshot:
    """이번 회차 추천 생산 시 사용한 규칙·가중치 세팅 (재현성 아카이브)."""

    round_no: int
    engine: str
    params: Dict[str, Any]
    created_at: str = field(default_factory=_utc_now_iso)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class DerivedRecommendation:
    """Current Dataset 전용 독립 생성 추천 데이터."""

    round_no: int
    engine: str
    payload: Dict[str, Any]
    rule_snapshot: RuleSnapshot
    created_at: str = field(default_factory=_utc_now_iso)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "round_no": self.round_no,
            "engine": self.engine,
            "payload": self.payload,
            "rule_snapshot": self.rule_snapshot.to_dict(),
            "created_at": self.created_at,
        }


@dataclass
class SandboxState:
    """Current Draw 샌드박스 메타."""

    round_no: int
    frozen: bool = False
    write_enabled: bool = True
    frozen_at: Optional[str] = None
    initialized_at: str = field(default_factory=_utc_now_iso)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class RolloverResult:
    """토요일 롤오버 배치 결과."""

    ok: bool
    closed_round: int
    next_round: int
    idempotent: bool = False
    backtest: Optional[Dict[str, Any]] = None
    integrity: Optional[Dict[str, Any]] = None
    merged_items: int = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ArchivedRoundBundle:
    """Historical로 이관된 N회차 확정 스냅숏."""

    round_no: int
    photo_entries: List[Dict[str, Any]]
    derived_recommendations: List[Dict[str, Any]]
    rule_snapshots: List[Dict[str, Any]]
    backtest: Dict[str, Any]
    archived_at: str = field(default_factory=_utc_now_iso)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
