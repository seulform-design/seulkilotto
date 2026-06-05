"""당첨 데이터 Repository."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.draws import LottoDraw


class DrawRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_all_ordered(self) -> List[LottoDraw]:
        stmt = select(LottoDraw).order_by(LottoDraw.round_no)
        return list(self.db.scalars(stmt).all())

    def get_latest(self) -> Optional[LottoDraw]:
        stmt = select(LottoDraw).order_by(LottoDraw.round_no.desc()).limit(1)
        return self.db.scalars(stmt).first()

    def upsert_many(self, draws: List[LottoDraw]) -> int:
        count = 0
        for d in draws:
            existing = self.db.get(LottoDraw, d.round_no)
            if existing:
                for k in ("draw_date", "machine_no", "num1", "num2", "num3", "num4", "num5", "num6", "bonus"):
                    setattr(existing, k, getattr(d, k))
            else:
                self.db.add(d)
            count += 1
        self.db.commit()
        return count
