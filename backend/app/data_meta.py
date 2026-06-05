"""데이터 적재 상태·메타정보 (헬스체크·프론트 동기화용)."""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

import pandas as pd

from .config import settings
from .database import BASE_COLUMNS, CSV_DATA_PATH, load_history


def effective_current_round(latest_round: int) -> int:
    """최신 추첨 회차+1 과 설정 하한 중 큰 값."""
    return max(latest_round + 1, settings.CURRENT_ROUND)


def get_history_meta() -> Dict[str, Any]:
    """현재 로드 가능한 데이터 요약."""
    try:
        df = load_history()
        source = getattr(df, "attrs", {}).get("source", "unknown")
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "source": "error",
            "error": str(exc),
            "current_round": settings.CURRENT_ROUND,
            "row_count": 0,
        }

    if df.empty:
        return {
            "ok": False,
            "source": source,
            "current_round": settings.CURRENT_ROUND,
            "row_count": 0,
            "message": "데이터가 비어 있습니다.",
        }

    rounds = df["round"].astype(int)
    latest = int(rounds.max())
    current = effective_current_round(latest)
    gaps = _find_gap_count(rounds.tolist())

    first_r = int(rounds.min())
    is_complete = gaps == 0 and first_r == 1 and latest >= current - 1

    return {
        "ok": len(df) > 0,
        "source": source,
        "current_round": current,
        "latest_round": latest,
        "next_round": current,
        "first_round": first_r,
        "row_count": len(df),
        "gap_count": gaps,
        "csv_path": str(CSV_DATA_PATH),
        "is_complete": is_complete,
    }


def _find_gap_count(sorted_rounds: List[int]) -> int:
    if not sorted_rounds:
        return 0
    s = sorted(set(sorted_rounds))
    return sum(1 for r in range(s[0], s[-1] + 1) if r not in s)
