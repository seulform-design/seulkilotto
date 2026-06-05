"""APScheduler 증분 갱신 작업."""
from __future__ import annotations

import logging
from pathlib import Path

from app.config import settings
from app.data.csv_loader import find_csv_path, load_csv_dataframe
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.engines.draw_frame import draws_to_frame
from app.engines.feature_builder import build_features_for_draws
from app.engines.pattern_index import PatternIndex
from app.models.draws import LottoDraw
from app.repositories.draw_repository import DrawRepository
from app.services.cache import cache_set

logger = logging.getLogger(__name__)


def sync_csv_incremental() -> dict:
    """
    v1 CSV 최신 회차를 DB에 반영하고 캐시 무효화.
    스케줄: 매주 토요일 22:00 (추첨 후) 등 cron 설정 가능.
    """
    csv_path = find_csv_path()
    if not csv_path:
        return {"ok": False, "error": "CSV not found"}

    df = load_csv_dataframe()
    if df is None or df.empty:
        return {"ok": False, "error": "empty csv"}

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        repo = DrawRepository(db)
        existing = {d.round_no for d in repo.get_all_ordered()}
        new_rows = 0
        import csv
        from datetime import datetime

        from app.engines.machine_utils import machine_from_date

        draws = []
        with csv_path.open("r", encoding="utf-8", newline="") as fp:
            for row in csv.DictReader(fp):
                rnd = int(row["round"])
                if rnd in existing:
                    continue
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
                new_rows += 1

        if draws:
            repo.upsert_many(draws)
            full_df = draws_to_frame(repo.get_all_ordered())
            for f in build_features_for_draws(full_df):
                db.merge(f)
            db.commit()

        idx = PatternIndex().build(df)
        cache_set(
            "pattern_index_meta",
            {"total": idx.total_draws, "synced_at": str(csv_path)},
            ttl=3600,
        )
        logger.info("Incremental sync: %s new rounds", new_rows)
        return {
            "ok": True,
            "new_rounds": new_rows,
            "total_csv_rows": len(df),
            "latest_round": int(df["round_no"].max()),
        }
    finally:
        db.close()


def rebuild_all_patterns_job() -> dict:
    """pair_pattern_stats 전체 재구축 (주기 작업)."""
    from app.services.research_service import ResearchService

    db = SessionLocal()
    try:
        svc = ResearchService(db)
        n = svc.rebuild_pattern_stats(db)
        return {"ok": True, "rebuilt_pairs": n}
    finally:
        db.close()
