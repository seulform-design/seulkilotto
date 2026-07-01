"""번호별 '미출현 간격' 단일 소스.

과거 classic_methods._gap_map / machine_analytics._absence_gaps /
temperature._compute_gaps 에 같은 계산이 제각각(인덱스 기반 vs 회차번호 기반,
never-seen 처리 상이) 구현돼 정합 위험이 있었다. 여기로 통일한다.

정의: 각 번호 1~45 의 '마지막 출현 이후 지나간 추첨 수'. 한 번도 안 나온
번호는 전체 추첨 수를 반환한다. 회차가 연속이면 (latest_round - last_round)
와 동일하다(로또 회차는 매주 연속이므로 실질적으로 동일).
"""
from __future__ import annotations

from typing import Dict

import pandas as pd

from .database import NUMBER_COLUMNS

ALL_NUMBERS = list(range(1, 46))


def last_seen_gaps(df: pd.DataFrame) -> Dict[int, int]:
    """{번호: 미출현 추첨 수}. 미출현 번호는 전체 추첨 수."""
    ordered = df.sort_values("round")
    last_idx: Dict[int, int] = {}
    idx = -1
    for idx, (_, row) in enumerate(ordered.iterrows()):
        for c in NUMBER_COLUMNS:
            v = int(row[c])
            if 1 <= v <= 45:
                last_idx[v] = idx
    draw_count = idx + 1
    return {
        num: (draw_count if num not in last_idx else (draw_count - 1) - last_idx[num])
        for num in ALL_NUMBERS
    }
