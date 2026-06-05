"""initial schema

Revision ID: 001
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "lotto_draws",
        sa.Column("round_no", sa.Integer(), primary_key=True),
        sa.Column("draw_date", sa.Date(), nullable=False),
        sa.Column("machine_no", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("num1", sa.SmallInteger(), nullable=False),
        sa.Column("num2", sa.SmallInteger(), nullable=False),
        sa.Column("num3", sa.SmallInteger(), nullable=False),
        sa.Column("num4", sa.SmallInteger(), nullable=False),
        sa.Column("num5", sa.SmallInteger(), nullable=False),
        sa.Column("num6", sa.SmallInteger(), nullable=False),
        sa.Column("bonus", sa.SmallInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("ix_lotto_draws_draw_date", "lotto_draws", ["draw_date"])

    op.create_table(
        "draw_features",
        sa.Column("round_no", sa.Integer(), sa.ForeignKey("lotto_draws.round_no"), primary_key=True),
        sa.Column("sum_total", sa.Integer(), nullable=False),
        sa.Column("average", sa.Float(), nullable=False),
        sa.Column("std", sa.Float(), nullable=False),
        sa.Column("odd_even_ratio", sa.Float(), nullable=False),
        sa.Column("high_low_ratio", sa.Float(), nullable=False),
        sa.Column("ac_value", sa.Float(), nullable=False),
        sa.Column("repeat_count", sa.SmallInteger(), nullable=False),
        sa.Column("neighbor_count", sa.SmallInteger(), nullable=False),
        sa.Column("consecutive_count", sa.SmallInteger(), nullable=False),
        sa.Column("end_digit_pattern", sa.String(32), nullable=False),
        sa.Column("cluster_distribution", sa.String(128), nullable=False),
        sa.Column("entropy_score", sa.Float(), nullable=False),
        sa.Column("machine_no", sa.SmallInteger(), nullable=False),
    )

    op.create_table(
        "pair_pattern_stats",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("num_a", sa.Integer(), nullable=False),
        sa.Column("num_b", sa.Integer(), nullable=False),
        sa.Column("pair_key", sa.String(16), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), server_default="0"),
        sa.Column("support", sa.Float(), server_default="0"),
        sa.Column("confidence", sa.Float(), server_default="0"),
        sa.Column("lift", sa.Float(), server_default="0"),
        sa.Column("pmi", sa.Float(), server_default="0"),
        sa.Column("top_next_numbers", sa.String(256), server_default=""),
        sa.Column("survival_rate", sa.Float(), server_default="0"),
        sa.Column("hit_rate", sa.Float(), server_default="0"),
        sa.Column("pattern_score", sa.Float(), server_default="0"),
        sa.UniqueConstraint("num_a", "num_b", name="uq_pair"),
    )
    op.create_index("ix_pair_key", "pair_pattern_stats", ["pair_key"])

    op.create_table(
        "triple_pattern_stats",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("num_a", sa.Integer(), nullable=False),
        sa.Column("num_b", sa.Integer(), nullable=False),
        sa.Column("num_c", sa.Integer(), nullable=False),
        sa.Column("triple_key", sa.String(24), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), server_default="0"),
        sa.Column("support", sa.Float(), server_default="0"),
        sa.Column("confidence", sa.Float(), server_default="0"),
        sa.Column("lift", sa.Float(), server_default="0"),
        sa.Column("top_next_numbers", sa.String(256), server_default=""),
        sa.Column("survival_keep_avg", sa.Float(), server_default="0"),
        sa.Column("pattern_score", sa.Float(), server_default="0"),
        sa.UniqueConstraint("num_a", "num_b", "num_c", name="uq_triple"),
    )
    op.create_index("ix_triple_key", "triple_pattern_stats", ["triple_key"])


def downgrade() -> None:
    op.drop_table("triple_pattern_stats")
    op.drop_table("pair_pattern_stats")
    op.drop_table("draw_features")
    op.drop_table("lotto_draws")
