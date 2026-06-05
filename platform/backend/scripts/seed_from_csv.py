#!/usr/bin/env python3
"""CSV → PostgreSQL lotto_draws + draw_features 적재."""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.engines.draw_frame import draws_to_frame
from app.engines.feature_builder import build_features_for_draws
from app.models.draws import LottoDraw
from app.models.features import DrawFeature
from app.engines.machine_utils import machine_from_date
from app.repositories.draw_repository import DrawRepository


def load_csv(path: Path) -> list[LottoDraw]:
    draws = []
    with path.open("r", encoding="utf-8", newline="") as fp:
        for row in csv.DictReader(fp):
            rnd = int(row["round"])
            draw_date = datetime.strptime(row["draw_date"][:10], "%Y-%m-%d").date()
            draws.append(
                LottoDraw(
                    round_no=rnd,
                    draw_date=draw_date,
                    machine_no=machine_from_date(draw_date),
                    num1=int(row["num1"]),
                    num2=int(row["num2"]),
                    num3=int(row["num3"]),
                    num4=int(row["num4"]),
                    num5=int(row["num5"]),
                    num6=int(row["num6"]),
                    bonus=int(row["bonus"]),
                )
            )
    return draws


def main() -> int:
    parser = argparse.ArgumentParser()
    default_csv = Path(__file__).resolve().parents[2] / "backend" / "data" / "lotto_history.csv"
    parser.add_argument("--csv", type=Path, default=default_csv)
    args = parser.parse_args()
    if not args.csv.is_file():
        # monorepo path
        alt = Path(__file__).resolve().parents[3] / "backend" / "data" / "lotto_history.csv"
        if alt.is_file():
            args.csv = alt
        else:
            print(f"[ERROR] CSV 없음: {args.csv}")
            return 1

    Base.metadata.create_all(bind=engine)
    draws = load_csv(args.csv)
    db = SessionLocal()
    try:
        repo = DrawRepository(db)
        n = repo.upsert_many(draws)
        df = draws_to_frame(draws)
        feats = build_features_for_draws(df)
        for f in feats:
            db.merge(f)
        db.commit()
        print(f"[OK] draws={n}, features={len(feats)} from {args.csv}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
