"""Pair/Triple 패턴 통계 저장 ORM."""
from sqlalchemy import Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PairPatternStat(Base):
    __tablename__ = "pair_pattern_stats"
    __table_args__ = (UniqueConstraint("num_a", "num_b", name="uq_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    num_a: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    num_b: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    pair_key: Mapped[str] = mapped_column(String(16), nullable=False, index=True)

    occurrence_count: Mapped[int] = mapped_column(Integer, default=0)
    support: Mapped[float] = mapped_column(Float, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    lift: Mapped[float] = mapped_column(Float, default=0.0)
    pmi: Mapped[float] = mapped_column(Float, default=0.0)

    top_next_numbers: Mapped[str] = mapped_column(String(256), default="")  # JSON "23:12,34:8"
    survival_rate: Mapped[float] = mapped_column(Float, default=0.0)
    hit_rate: Mapped[float] = mapped_column(Float, default=0.0)
    pattern_score: Mapped[float] = mapped_column(Float, default=0.0)


class TriplePatternStat(Base):
    __tablename__ = "triple_pattern_stats"
    __table_args__ = (UniqueConstraint("num_a", "num_b", "num_c", name="uq_triple"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    num_a: Mapped[int] = mapped_column(Integer, nullable=False)
    num_b: Mapped[int] = mapped_column(Integer, nullable=False)
    num_c: Mapped[int] = mapped_column(Integer, nullable=False)
    triple_key: Mapped[str] = mapped_column(String(24), nullable=False, index=True)

    occurrence_count: Mapped[int] = mapped_column(Integer, default=0)
    support: Mapped[float] = mapped_column(Float, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    lift: Mapped[float] = mapped_column(Float, default=0.0)

    top_next_numbers: Mapped[str] = mapped_column(String(256), default="")
    survival_keep_avg: Mapped[float] = mapped_column(Float, default=0.0)
    pattern_score: Mapped[float] = mapped_column(Float, default=0.0)
