"""이월수·이웃수 분석 엔진."""
from __future__ import annotations

from typing import Dict, List, Optional

from app.engines.draw_frame import row_numbers


def analyze_repeat(df, windows: List[int] | None = None) -> Dict:
    windows = windows or [10, 30, 50, 100]
    ordered = df.sort_values("round_no")
    rounds = [row_numbers(r) for _, r in ordered.iterrows()]
    all_rates = []
    for i in range(1, len(rounds)):
        prev, curr = set(rounds[i - 1]), set(rounds[i])
        all_rates.append(len(prev & curr) / 6)

    def rate_last(n: int) -> float:
        if len(all_rates) < n:
            return round(sum(all_rates) / max(len(all_rates), 1), 4)
        return round(sum(all_rates[-n:]) / n, 4)

    return {
        "overall_rate": round(sum(all_rates) / max(len(all_rates), 1), 4),
        "by_window": {f"last_{w}": rate_last(w) for w in windows},
        "evidence": "이월수 = 전회차 당첨번호 ∩ 당회차 / 6",
        "disclaimer": "독립시행 하에서는 회차별 상관이 우연일 수 있습니다.",
    }


def analyze_neighbor(df, windows: List[int] | None = None) -> Dict:
    windows = windows or [10, 30, 50, 100]
    ordered = df.sort_values("round_no")
    rounds = [row_numbers(r) for _, r in ordered.iterrows()]
    all_rates = []
    for i in range(1, len(rounds)):
        prev = set(rounds[i - 1])
        curr = rounds[i]
        c = sum(1 for x in curr if (x - 1) in prev or (x + 1) in prev)
        all_rates.append(c / 6)

    def rate_last(n: int) -> float:
        if len(all_rates) < n:
            return round(sum(all_rates) / max(len(all_rates), 1), 4)
        return round(sum(all_rates[-n:]) / n, 4)

    return {
        "definition": "전회차 당첨번호 ±1",
        "overall_rate": round(sum(all_rates) / max(len(all_rates), 1), 4),
        "by_window": {f"last_{w}": rate_last(w) for w in windows},
        "evidence": "이웃수 비율 = |curr ∩ (prev±1)| / 6",
    }
