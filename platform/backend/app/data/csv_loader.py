"""PostgreSQL 미적재 시 v1 CSV 폴백."""
from __future__ import annotations

import csv
import os
from datetime import datetime
from pathlib import Path

import pandas as pd

from app.engines.draw_frame import row_numbers


def find_csv_path() -> Path | None:
    """회차 CSV 위치를 탐색.

    배포 컨테이너(Railway)에서 v1(backend/app)이 회차 CSV 를
    `<repo>/backend/data/lotto_history.csv`(볼륨: /app/backend/data/…)에 기록하는데,
    기존 후보에는 이 경로가 빠져 있어 v2 증분 동기화가 항상 "CSV not found" 로
    실패했다. v1 정본 경로와 env 오버라이드를 최우선 후보로 추가한다.
    """
    here = Path(__file__).resolve()
    # here = <repo>/platform/backend/app/data/csv_loader.py
    #   parents[2] = <repo>/platform/backend, parents[4] = <repo>
    repo_root = here.parents[4] if len(here.parents) > 4 else here.parents[-1]
    env = os.environ.get("LOTTO_CSV_PATH")
    candidates = [
        Path(env) if env else None,
        # v1 정본 CSV — 배포 컨테이너에서 v1 이 실제로 기록/갱신하는 위치.
        repo_root / "backend" / "data" / "lotto_history.csv",
        Path("/app/backend/data/lotto_history.csv"),
        # v2 자체 데이터 디렉터리(로컬 개발/독립 배포용).
        here.parents[2] / "data" / "lotto_history.csv",
        Path("/data/lotto_history.csv"),
    ]
    for p in candidates:
        if p and p.is_file():
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
