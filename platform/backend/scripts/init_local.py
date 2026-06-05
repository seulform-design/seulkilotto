#!/usr/bin/env python3
"""로컬 SQLite 초기화 + CSV 시드 + 패턴 통계 (원스텝)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.services.research_service import ResearchService


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        from scripts.seed_from_csv import load_csv, main as seed_main

        seed_main()
        svc = ResearchService(db)
        n = svc.rebuild_pattern_stats(db)
        st = svc.data_status()
        print(f"[OK] patterns={n}, status={st}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
