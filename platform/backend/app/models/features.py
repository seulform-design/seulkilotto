"""회차별 Feature Store ORM."""
from sqlalchemy import Float, ForeignKey, Integer, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DrawFeature(Base):
    __tablename__ = "draw_features"

    round_no: Mapped[int] = mapped_column(Integer, ForeignKey("lotto_draws.round_no"), primary_key=True)
    sum_total: Mapped[int] = mapped_column(Integer, nullable=False)
    average: Mapped[float] = mapped_column(Float, nullable=False)
    std: Mapped[float] = mapped_column(Float, nullable=False)
    odd_even_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    high_low_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    ac_value: Mapped[float] = mapped_column(Float, nullable=False)
    repeat_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    neighbor_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    consecutive_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    end_digit_pattern: Mapped[str] = mapped_column(String(32), nullable=False)
    cluster_distribution: Mapped[str] = mapped_column(String(128), nullable=False)
    entropy_score: Mapped[float] = mapped_column(Float, nullable=False)
    machine_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
