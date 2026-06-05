#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lotto_history.csv 회차 커버리지 검증 (표준 라이브러리만)."""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import List, Set, Tuple

DEFAULT_START_ROUND = 1


def _current_round() -> int:
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from app.config import settings
        return settings.CURRENT_ROUND
    except Exception:
        return 1227


def load_rounds(csv_path: Path) -> Tuple[List[int], List[str]]:
    rounds: List[int] = []
    errors: List[str] = []
    with csv_path.open("r", encoding="utf-8", newline="") as fp:
        reader = csv.DictReader(fp)
        if not reader.fieldnames or "round" not in reader.fieldnames:
            return [], ["CSV에 round 컬럼이 없습니다."]
        for line_no, row in enumerate(reader, start=2):
            try:
                rounds.append(int(row["round"].strip()))
            except (KeyError, ValueError) as exc:
                errors.append(f"{line_no}행: {exc}")
    return sorted(rounds), errors


def find_gaps(sorted_rounds: List[int], start: int, end: int) -> List[Tuple[int, int]]:
    """누락 구간을 (시작, 끝) 리스트로 반환."""
    have: Set[int] = set(sorted_rounds)
    gaps: List[Tuple[int, int]] = []
    gap_start: int | None = None
    for r in range(start, end + 1):
        if r not in have:
            if gap_start is None:
                gap_start = r
        else:
            if gap_start is not None:
                gaps.append((gap_start, r - 1))
                gap_start = None
    if gap_start is not None:
        gaps.append((gap_start, end))
    return gaps


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="로또 CSV 회차 누락 검증")
    parser.add_argument("--csv", type=Path, default=script_dir.parent / "data" / "lotto_history.csv")
    parser.add_argument("--start", type=int, default=DEFAULT_START_ROUND)
    parser.add_argument("--end", type=int, default=None, help="검증 종료 회차 (기본: CURRENT_ROUND-1)")
    args = parser.parse_args()

    if not args.csv.is_file():
        print(f"[ERROR] 파일 없음: {args.csv}", file=sys.stderr)
        return 1

    rounds, parse_errors = load_rounds(args.csv)
    for e in parse_errors:
        print(f"[WARN] {e}")

    end = args.end if args.end is not None else _current_round() - 1
    start, end = args.start, end
    expected_count = end - start + 1
    have_set = set(rounds)
    in_range = [r for r in rounds if start <= r <= end]
    missing_count = expected_count - len(in_range)

    print("=" * 60)
    print("  로또 데이터 회차 커버리지 검증")
    print("=" * 60)
    print(f"  파일: {args.csv.resolve()}")
    print(f"  검증 범위: {start}회 ~ {end}회 (총 {expected_count}회차)")
    print(f"  CSV 행 수: {len(rounds)}")
    if rounds:
        print(f"  CSV 회차 범위: {rounds[0]} ~ {rounds[-1]}")
    print()

    if missing_count == 0 and len(in_range) == expected_count:
        print("  [OK] 검증 범위 내 모든 회차가 존재합니다.")
        if len(rounds) != expected_count:
            print(f"  [INFO] 범위 밖 추가 회차: {len(rounds) - len(in_range)}건")
        return 0

    coverage = (len(in_range) / expected_count * 100) if expected_count else 0
    print(f"  [NG] 누락 회차: {missing_count}개 ({coverage:.1f}% 채움)")
    print()

    gaps = find_gaps(in_range, start, end)
    print(f"  누락 구간 수: {len(gaps)}")
    show = gaps[:15]
    for a, b in show:
        if a == b:
            print(f"    - {a}회")
        else:
            print(f"    - {a}회 ~ {b}회 ({b - a + 1}회차)")
    if len(gaps) > 15:
        print(f"    ... 외 {len(gaps) - 15}개 구간")

    print()
    print("  [조치] 전체 적재:")
    print("    python crawl_lotto_history.py --start 1 --end", end)
    print()
    return 2


if __name__ == "__main__":
    sys.exit(main())
