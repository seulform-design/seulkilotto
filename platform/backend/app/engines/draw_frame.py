"""당첨 데이터 → 분석용 DataFrame."""
from __future__ import annotations

from typing import List, Sequence

import pandas as pd

from app.engines.common import NUM_COLS
from app.models.draws import LottoDraw


def draws_to_frame(draws: Sequence[LottoDraw]) -> pd.DataFrame:
    rows = []
    for d in sorted(draws, key=lambda x: x.round_no):
        rows.append(
            {
                "round_no": d.round_no,
                "draw_date": d.draw_date,
                "machine_no": d.machine_no,
                **{f"num{i}": n for i, n in enumerate(d.numbers(), 1)},
                "bonus": d.bonus,
            }
        )
    return pd.DataFrame(rows)


def row_numbers(row) -> List[int]:
    return sorted(int(row[c]) for c in NUM_COLS)
