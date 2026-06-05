#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lotto_history.csv -> PostgreSQL 적재 (표준 라이브러리 전용).

psycopg2 없이 SQL 파일을 생성하거나, 환경에 psycopg2 가 있으면 직접 INSERT 합니다.

실행:
  python import_lotto_csv.py
  python import_lotto_csv.py --csv ../data/lotto_history.csv --sql ../data/import_lotto.sql
  python import_lotto_csv.py --execute  # psycopg2 설치 시 DB 직접 적재
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Dict, List, Optional

CSV_COLUMNS = [
    "round",
    "draw_date",
    "num1",
    "num2",
    "num3",
    "num4",
    "num5",
    "num6",
    "bonus",
]


def load_csv_rows(path: Path) -> List[Dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(f"CSV 없음: {path}")

    rows: List[Dict[str, str]] = []
    with path.open("r", encoding="utf-8", newline="") as fp:
        reader = csv.DictReader(fp)
        if not reader.fieldnames:
            raise ValueError("CSV 헤더 없음")
        missing = set(CSV_COLUMNS) - set(reader.fieldnames)
        if missing:
            raise ValueError(f"필수 컬럼 누락: {sorted(missing)}")

        for line_no, raw in enumerate(reader, start=2):
            try:
                _validate_row(raw)
                rows.append({k: raw[k].strip() for k in CSV_COLUMNS})
            except ValueError as exc:
                print(f"[WARN] {line_no}행 스킵: {exc}")

    if not rows:
        raise ValueError("적재할 데이터가 없습니다. crawl_lotto_history.py 를 먼저 실행하세요.")
    return rows


def _validate_row(raw: Dict[str, str]) -> None:
    nums = [int(raw[f"num{i}"].strip()) for i in range(1, 7)]
    if len(set(nums)) != 6:
        raise ValueError("당첨번호 중복")
    for n in nums + [int(raw["bonus"].strip())]:
        if not (1 <= n <= 45):
            raise ValueError(f"번호 범위 오류: {n}")


def build_sql(rows: List[Dict[str, str]]) -> str:
    """INSERT ... ON CONFLICT DO UPDATE SQL 생성."""
    lines = [
        "-- lotto_history.csv 자동 생성 SQL",
        "BEGIN;",
    ]
    for r in rows:
        lines.append(
            "INSERT INTO lotto_history "
            "(round, draw_date, num1, num2, num3, num4, num5, num6, bonus, "
            "first_prize_amount, first_winner_count) "
            f"VALUES ({r['round']}, '{r['draw_date']}', "
            f"{r['num1']}, {r['num2']}, {r['num3']}, {r['num4']}, "
            f"{r['num5']}, {r['num6']}, {r['bonus']}, 0, 0) "
            "ON CONFLICT (round) DO UPDATE SET "
            "draw_date = EXCLUDED.draw_date, "
            "num1 = EXCLUDED.num1, num2 = EXCLUDED.num2, "
            "num3 = EXCLUDED.num3, num4 = EXCLUDED.num4, "
            "num5 = EXCLUDED.num5, num6 = EXCLUDED.num6, "
            "bonus = EXCLUDED.bonus;"
        )
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def execute_with_psycopg2(rows: List[Dict[str, str]], database_url: str) -> int:
    """psycopg2 가 설치된 경우 직접 적재."""
    try:
        import psycopg2
    except ImportError:
        print("[ERROR] psycopg2 가 없습니다. pip install psycopg2-binary 후 재시도하거나")
        print("        --sql 로 생성한 파일을 psql 로 실행하세요.")
        return 1

    # sqlalchemy URL -> psycopg2 DSN 단순 변환
    dsn = database_url.replace("postgresql+psycopg2://", "postgresql://")

    sql = (
        "INSERT INTO lotto_history "
        "(round, draw_date, num1, num2, num3, num4, num5, num6, bonus, "
        "first_prize_amount, first_winner_count) "
        "VALUES (%(round)s, %(draw_date)s, %(num1)s, %(num2)s, %(num3)s, "
        "%(num4)s, %(num5)s, %(num6)s, %(bonus)s, 0, 0) "
        "ON CONFLICT (round) DO UPDATE SET "
        "draw_date = EXCLUDED.draw_date, "
        "num1 = EXCLUDED.num1, num2 = EXCLUDED.num2, "
        "num3 = EXCLUDED.num3, num4 = EXCLUDED.num4, "
        "num5 = EXCLUDED.num5, num6 = EXCLUDED.num6, "
        "bonus = EXCLUDED.bonus"
    )

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            for r in rows:
                payload = {k: int(r[k]) if k != "draw_date" else r[k] for k in CSV_COLUMNS}
                cur.execute(sql, payload)
        conn.commit()
    finally:
        conn.close()

    print(f"[DONE] PostgreSQL 적재 완료: {len(rows)}건")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    script_dir = Path(__file__).resolve().parent
    default_csv = script_dir.parent / "data" / "lotto_history.csv"
    default_sql = script_dir.parent / "data" / "import_lotto.sql"

    parser = argparse.ArgumentParser(description="CSV -> PostgreSQL 적재")
    parser.add_argument("--csv", type=Path, default=default_csv)
    parser.add_argument("--sql", type=Path, default=default_sql)
    parser.add_argument("--execute", action="store_true", help="DB 직접 적재 (psycopg2 필요)")
    parser.add_argument(
        "--database-url",
        type=str,
        default="postgresql://postgres:postgres@localhost:5432/lotto",
    )
    args = parser.parse_args(argv)

    try:
        rows = load_csv_rows(args.csv)
        print(f"[INFO] CSV 로드: {len(rows)}건 ({args.csv})")

        args.sql.parent.mkdir(parents=True, exist_ok=True)
        args.sql.write_text(build_sql(rows), encoding="utf-8")
        print(f"[INFO] SQL 파일 생성: {args.sql.resolve()}")
        print("       psql -U postgres -d lotto -f import_lotto.sql")

        if args.execute:
            return execute_with_psycopg2(rows, args.database_url)
        return 0

    except (FileNotFoundError, ValueError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
