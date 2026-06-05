#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
로또 분석기 데이터 파이프라인 일괄 실행 (표준 라이브러리 + subprocess).

순서: [1] 크롤링 -> [2] CSV 검증 -> [3] SQL 생성 -> [4] 호기 분석/추천 -> [5] API 안내

실행:
  python run_pipeline.py
  python run_pipeline.py --skip-crawl              # 기존 CSV 로 검증·분석만
  python run_pipeline.py --latest-only             # 최신 1회차만 크롤 후 파이프라인
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def run_step(label: str, cmd: list[str], cwd: Path) -> int:
    print()
    print("=" * 60)
    print(f"  {label}")
    print("=" * 60)
    print(" ", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(cwd))
    return result.returncode


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    data_csv = script_dir.parent / "data" / "lotto_history.csv"

    parser = argparse.ArgumentParser(description="로또 데이터 파이프라인")
    parser.add_argument("--start", type=int, default=1, help="크롤링 시작 회차")
    parser.add_argument("--end", type=int, default=None, help="크롤링 종료 회차")
    parser.add_argument("--skip-crawl", action="store_true", help="크롤링 생략")
    parser.add_argument(
        "--latest-only",
        action="store_true",
        help="CSV 최신 회차+1 ~ CURRENT_ROUND-1 구간만 크롤 (신규 추첨 반영용)",
    )
    parser.add_argument("--source", choices=("auto", "dhlottery", "lottis"), default="lottis")
    parser.add_argument("--machine", type=str, default="auto", help="호기: 1|2|3|auto")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    py = sys.executable

    if not args.skip_crawl:
        crawl_start = args.start
        crawl_end = args.end
        if args.latest_only:
            sys.path.insert(0, str(script_dir.parent))
            try:
                from app.config import settings  # noqa: WPS433
            except ImportError:
                settings = type("S", (), {"CURRENT_ROUND": 1227})()
            latest_in_csv = 0
            if data_csv.is_file():
                import csv as _csv

                with data_csv.open("r", encoding="utf-8", newline="") as fp:
                    for row in _csv.DictReader(fp):
                        try:
                            latest_in_csv = max(latest_in_csv, int(row.get("round", 0)))
                        except ValueError:
                            pass
            crawl_start = max(crawl_start, latest_in_csv + 1)
            crawl_end = crawl_end or (settings.CURRENT_ROUND - 1)
            if crawl_start > crawl_end:
                print(f"[INFO] 크롤 생략: CSV 최신 {latest_in_csv}회, 대기 중인 추첨 없음")
            else:
                print(f"[INFO] 최신만 크롤: {crawl_start}~{crawl_end}회")

        if crawl_end is None and not args.latest_only:
            crawl_cmd = [py, "crawl_lotto_history.py", "--start", str(crawl_start), "--source", args.source]
        elif crawl_start <= (crawl_end or crawl_start):
            crawl_cmd = [
                py,
                "crawl_lotto_history.py",
                "--start",
                str(crawl_start),
                "--end",
                str(crawl_end or crawl_start),
                "--source",
                args.source,
            ]
        else:
            crawl_cmd = None

        if crawl_cmd:
            crawl_cmd += ["--output", str(data_csv)]
            code = run_step("[1/5] 동행복권 크롤링", crawl_cmd, script_dir)
            if code not in (0, 2):
                print("[ERROR] 크롤링 실패")
                return code

    verify_cmd = [py, "verify_lotto_coverage.py"]
    code = run_step("[2/5] CSV 회차 커버리지 검증", verify_cmd, script_dir)
    if code != 0:
        print("[ERROR] CSV 검증 실패 — 누락 회차를 crawl 후 재실행하세요.")
        return code

    import_cmd = [py, "import_lotto_csv.py", "--csv", str(data_csv)]
    run_step("[3/5] SQL 적재 파일 생성", import_cmd, script_dir)

    analyze_cmd = [
        py,
        "analyze_machine_patterns.py",
        "--csv",
        str(data_csv),
        "--machine",
        args.machine,
        "--no-prompt",
        "--seed",
        str(args.seed),
    ]
    code = run_step("[4/5] 호기 패턴 분석 및 추천", analyze_cmd, script_dir)
    if code != 0:
        return code

    print()
    print("=" * 60)
    print("  [5/5] 백엔드 API 실행 안내")
    print("=" * 60)
    print("  cd ../")
    print("  python -m uvicorn app.main:app --reload --port 8000")
    print()
    print("  프론트엔드:")
    print("  cd ../../frontend && npm start")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
