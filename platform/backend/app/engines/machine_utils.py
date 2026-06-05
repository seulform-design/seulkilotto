"""추첨일 기반 호기(1~3) 추정 — v1 machine_analytics 와 동일 규칙."""
from __future__ import annotations

from datetime import date
from typing import Dict, Tuple

QUARTER_TO_MACHINE: Dict[Tuple[int, int], int] = {
    (2023, 1): 2, (2023, 2): 3, (2023, 3): 1, (2023, 4): 2,
    (2024, 1): 3, (2024, 2): 1, (2024, 3): 2, (2024, 4): 3,
    (2025, 1): 1, (2025, 2): 2, (2025, 3): 3, (2025, 4): 1,
    (2026, 1): 2, (2026, 2): 3, (2026, 3): 1, (2026, 4): 2,
}
MONTH_TO_MACHINE: Dict[Tuple[int, int], int] = {
    **{(2024, m): {1: 3, 2: 3, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 3, 9: 3, 10: 3, 11: 2, 12: 2}[m] for m in range(1, 13)},
    **{(2025, m): {1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 1, 10: 1, 11: 2, 12: 2}[m] for m in range(1, 13)},
    **{(2026, m): {1: 2, 2: 2, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 2, 10: 2, 11: 3, 12: 3}[m] for m in range(1, 13)},
}
CYCLE_ANCHOR = (2002, 1, 1)


def _quarter(d: date) -> int:
    return (d.month - 1) // 3 + 1


def machine_from_date(d: date) -> int:
    qk = (d.year, _quarter(d))
    if qk in QUARTER_TO_MACHINE:
        return QUARTER_TO_MACHINE[qk]
    mk = (d.year, d.month)
    if mk in MONTH_TO_MACHINE:
        return MONTH_TO_MACHINE[mk]
    ay, aq, am = CYCLE_ANCHOR
    offset = (d.year - ay) * 4 + (_quarter(d) - aq)
    return ((am - 1 + offset) % 3) + 1
