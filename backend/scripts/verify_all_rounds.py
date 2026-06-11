"""CSV 1~N 전 회차를 lottis.kr과 대조 검증."""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import crawl_lotto_history as crawl  # noqa: E402

NUMS = [f"num{i}" for i in range(1, 7)]
CSV_PATH = SCRIPT_DIR.parent / "data" / "lotto_history.csv"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--delay", type=float, default=0.2)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=None)
    args = parser.parse_args()

    df = pd.read_csv(CSV_PATH)
    df["round"] = df["round"].astype(int)
    csv_rounds = set(df["round"].tolist())
    end = args.end or int(df["round"].max())

    missing_in_csv = [r for r in range(args.start, end + 1) if r not in csv_rounds]
    mismatch: list[dict] = []
    api_fail: list[int] = []
    ok = 0

    print(f"CSV: {len(df)}행, 범위 {df['round'].min()}~{df['round'].max()}")
    print(f"검증: {args.start}~{end} ({end - args.start + 1}회차)")
    if missing_in_csv:
        print(f"CSV 누락: {len(missing_in_csv)}회 — {missing_in_csv[:20]}")

    for r in range(args.start, end + 1):
        if r not in csv_rounds:
            continue
        ext = crawl.fetch_lottis_round(r, timeout=15)
        time.sleep(args.delay)
        if not ext:
            api_fail.append(r)
            if len(api_fail) <= 5:
                print(f"[FAIL] {r}회 lottis 조회 실패")
            continue
        row = df[df["round"] == r].iloc[-1]
        loc = sorted(int(row[c]) for c in NUMS)
        loc_b = int(row["bonus"])
        ext_nums = sorted(int(ext[c]) for c in NUMS)
        ext_b = int(ext["bonus"])
        if loc != ext_nums or loc_b != ext_b:
            mismatch.append(
                {
                    "round": r,
                    "csv": (loc, loc_b),
                    "lottis": (ext_nums, ext_b),
                }
            )
            print(f"[MISMATCH] {r}회 csv={loc}+{loc_b} lottis={ext_nums}+{ext_b}")
        else:
            ok += 1
        if r % 100 == 0:
            print(f"... {r}회차 진행 (OK {ok}, 불일치 {len(mismatch)}, 실패 {len(api_fail)})")

    print("\n=== 최종 ===")
    print(f"일치: {ok}")
    print(f"불일치: {len(mismatch)}")
    print(f"lottis 조회실패: {len(api_fail)}")
    print(f"CSV 누락: {len(missing_in_csv)}")
    if api_fail:
        print(f"실패 회차: {api_fail}")
    if mismatch:
        for m in mismatch[:20]:
            print(m)
    return 0 if not mismatch and not missing_in_csv and not api_fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
