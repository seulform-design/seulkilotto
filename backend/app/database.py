"""DB 연결 및 데이터 로딩 계층."""
from __future__ import annotations

import csv
import datetime as dt
import logging
import random
import time
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from .config import settings

logger = logging.getLogger(__name__)

CSV_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "lotto_history.csv"

NUMBER_COLUMNS = ["num1", "num2", "num3", "num4", "num5", "num6"]
BASE_COLUMNS = ["round", "draw_date", *NUMBER_COLUMNS, "bonus"]

_engine: Engine | None = None
_last_source: str = "unknown"
_cache_df: pd.DataFrame | None = None
_cache_at: float = 0.0
_cache_csv_mtime: float = 0.0


def get_last_data_source() -> str:
    return _last_source


def get_engine() -> Engine | None:
    global _engine
    if _engine is None:
        if not settings.DATABASE_URL.startswith("postgresql"):
            return None
        try:
            import psycopg2  # noqa: F401
        except ImportError:
            logger.info("psycopg2 미설치 — PostgreSQL 건너뜀, CSV 사용")
            return None
        try:
            _engine = create_engine(settings.DATABASE_URL, pool_pre_ping=True)
            with _engine.connect():
                pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("PostgreSQL 연결 실패, CSV/모의 데이터 사용: %s", exc)
            _engine = None
    return _engine


def _csv_mtime() -> float:
    try:
        return CSV_DATA_PATH.stat().st_mtime if CSV_DATA_PATH.is_file() else 0.0
    except OSError:
        return 0.0


def invalidate_history_cache() -> None:
    global _cache_df, _cache_at, _cache_csv_mtime
    _cache_df = None
    _cache_at = 0.0
    _cache_csv_mtime = 0.0


def _validate_row(row: dict) -> dict | None:
    """한 행 검증. 실패 시 None."""
    try:
        r = int(row["round"])
        nums = [int(row[c]) for c in NUMBER_COLUMNS]
        bonus = int(row["bonus"])
    except (KeyError, TypeError, ValueError):
        return None
    if len(set(nums)) != 6:
        return None
    if bonus in nums:
        return None
    if not all(1 <= n <= 45 for n in nums + [bonus]):
        return None
    draw_date = str(row["draw_date"])[:10]
    return {
        "round": r,
        "draw_date": draw_date,
        **{NUMBER_COLUMNS[i]: nums[i] for i in range(6)},
        "bonus": bonus,
    }


def _normalize_df(df: pd.DataFrame) -> pd.DataFrame:
    """중복 회차 제거(마지막 우선), round 정렬."""
    if df.empty:
        return df
    out = df.drop_duplicates(subset=["round"], keep="last")
    return out.sort_values("round").reset_index(drop=True)


def _generate_mock_history(n_rounds: int = 200) -> pd.DataFrame:
    global _last_source
    _last_source = "mock"
    logger.warning("모의 데이터 사용 중 (CSV/DB 없음)")
    rng = random.Random(42)
    rows = []
    start_date = dt.date(2021, 1, 2)
    for i in range(n_rounds):
        nums = sorted(rng.sample(range(1, 46), 6))
        bonus = rng.choice([x for x in range(1, 46) if x not in nums])
        rows.append(
            {
                "round": 1000 + i,
                "draw_date": (start_date + dt.timedelta(weeks=i)).isoformat(),
                **{col: nums[j] for j, col in enumerate(NUMBER_COLUMNS)},
                "bonus": bonus,
            }
        )
    df = pd.DataFrame(rows, columns=BASE_COLUMNS)
    df.attrs["source"] = "mock"
    return df


def _load_from_csv() -> pd.DataFrame | None:
    global _last_source
    if not CSV_DATA_PATH.is_file():
        return None

    rows: list[dict] = []
    skipped = 0
    with CSV_DATA_PATH.open("r", encoding="utf-8", newline="") as fp:
        reader = csv.DictReader(fp)
        if not reader.fieldnames:
            return None
        for raw in reader:
            parsed = _validate_row(
                {
                    "round": raw.get("round"),
                    "draw_date": raw.get("draw_date"),
                    **{f"num{i}": raw.get(f"num{i}") for i in range(1, 7)},
                    "bonus": raw.get("bonus"),
                }
            )
            if parsed is None:
                skipped += 1
                continue
            rows.append(parsed)

    if skipped:
        logger.warning("CSV %d행 파싱 스킵", skipped)
    if not rows:
        return None

    _last_source = "csv"
    df = pd.DataFrame(rows, columns=BASE_COLUMNS)
    df.attrs["source"] = "csv"
    return _normalize_df(df)


def _load_history_uncached() -> pd.DataFrame:
    """PostgreSQL > CSV > 모의 데이터 순으로 로드 (캐시 없음)."""
    global _last_source

    engine = get_engine()
    if engine is not None:
        try:
            query = f"SELECT {', '.join(BASE_COLUMNS)} FROM lotto_history ORDER BY round ASC"
            df = pd.read_sql(query, engine)
            if len(df) > 0:
                _last_source = "postgresql"
                df.attrs["source"] = "postgresql"
                return _normalize_df(df)
        except Exception as exc:  # noqa: BLE001
            logger.warning("DB 조회 실패, CSV 폴백: %s", exc)

    csv_df = _load_from_csv()
    if csv_df is not None:
        return csv_df

    return _generate_mock_history()


def load_history() -> pd.DataFrame:
    """캐시된 DataFrame 반환 (TTL + CSV mtime 기준 무효화)."""
    global _cache_df, _cache_at, _cache_csv_mtime

    now = time.time()
    mtime = _csv_mtime()
    ttl = settings.HISTORY_CACHE_TTL
    if (
        _cache_df is not None
        and now - _cache_at < ttl
        and mtime == _cache_csv_mtime
    ):
        return _cache_df

    df = _load_history_uncached()
    _cache_df = df
    _cache_at = now
    _cache_csv_mtime = mtime
    return df
