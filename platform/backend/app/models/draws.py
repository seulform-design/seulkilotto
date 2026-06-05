"""당첨 회차 ORM."""
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Integer, SmallInteger, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LottoDraw(Base):
    __tablename__ = "lotto_draws"

    round_no: Mapped[int] = mapped_column(Integer, primary_key=True)
    draw_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    machine_no: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)

    num1: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    num2: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    num3: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    num4: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    num5: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    num6: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    bonus: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    def numbers(self) -> list[int]:
        return sorted([self.num1, self.num2, self.num3, self.num4, self.num5, self.num6])
