"""PostgreSQL 미적재 시 v1 CSV 폴백."""
from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

import pandas as pd

from app.engines.draw_frame import row_numbers


def find_csv_path() -> Path | None:
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "data" / "lotto_history.csv",
        here.parents[3] / "backend" / "data" / "lotto_history.csv",
        Path("/data/lotto_history.csv"),
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def load_csv_dataframe() -> pd.DataFrame | None:
    path = find_csv_path()
    if not path:
        return None
    rows = []
    with path.open("r", encoding="utf-8", newline="") as fp:
        for raw in csv.DictReader(fp):
            rows.append(
                {
                    "round_no": int(raw["round"]),
                    "draw_date": raw["draw_date"][:10],
                    "machine_no": 1,
                    "num1": int(raw["num1"]),
                    "num2": int(raw["num2"]),
                    "num3": int(raw["num3"]),
                    "num4": int(raw["num4"]),
                    "num5": int(raw["num5"]),
                    "num6": int(raw["num6"]),
                    "bonus": int(raw["bonus"]),
                }
            )
    return pd.DataFrame(rows).sort_values("round_no")
