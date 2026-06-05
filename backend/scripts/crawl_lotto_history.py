#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
동행복권 역대 당첨 데이터 크롤링 및 lotto_history.csv 적재 스크립트.

의존성: Python 표준 라이브러리만 사용 (urllib.request, json, csv, time 등).
API: https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo={회차}

실행 예:
  python crawl_lotto_history.py
  python crawl_lotto_history.py --start 1 --output ../data/lotto_history.csv
  python crawl_lotto_history.py --start 1000 --delay 0.5
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Set, Tuple

SourceKind = Literal["auto", "dhlottery", "lottis"]

# -----------------------------------------------------------------------------
# 상수
# -----------------------------------------------------------------------------
API_BASE = "https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo="
LOTTIS_URL = "https://lottis.kr/lotto/{round}"
# 1회차 추첨일(토요일) 기준 — API 날짜 없을 때 주차 계산용
LOTTO_EPOCH_DATE = date(2002, 12, 7)

DEFAULT_DELAY_SEC = 0.35
DEFAULT_TIMEOUT_SEC = 15
MAX_RETRIES = 3
BINARY_SEARCH_HIGH = 2000  # 최신 회차 상한 (연 1회 증가 대비 여유)
CHECKPOINT_EVERY = 50

# CSV 컬럼 (DB schema.sql 의 lotto_history 와 호환)
CSV_FIELDNAMES = [
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


# -----------------------------------------------------------------------------
# API 호출
# -----------------------------------------------------------------------------
def fetch_lotto_round(
    round_no: int,
    timeout: float,
    retries: int = MAX_RETRIES,
) -> Optional[Dict[str, Any]]:
    """특정 회차 API 응답을 JSON dict 로 반환한다.

    - returnValue == 'success' 인 경우만 dict 반환.
    - 존재하지 않는 회차(returnValue == 'fail')는 None.
    - 네트워크/파싱 오류 시 최대 retries 회 재시도 후 None.
    """
    url = f"{API_BASE}{round_no}"
    last_error: Optional[Exception] = None

    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    # 동행복권은 Referer / 브라우저 UA 없으면 연결을 끊는 경우가 있음
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"
                    ),
                    "Referer": "https://www.dhlottery.co.kr/",
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "ko-KR,ko;q=0.9",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")

            payload = json.loads(raw)
            if not isinstance(payload, dict):
                print(f"[WARN] 회차 {round_no}: JSON 루트가 객체가 아님 → 스킵")
                return None

            if payload.get("returnValue") != "success":
                # 미개최/미존재 회차
                return None

            return payload

        except urllib.error.HTTPError as exc:
            last_error = exc
            print(
                f"[WARN] 회차 {round_no} HTTP {exc.code} "
                f"(시도 {attempt}/{retries})"
            )
        except urllib.error.URLError as exc:
            last_error = exc
            print(
                f"[WARN] 회차 {round_no} 네트워크 오류: {exc.reason} "
                f"(시도 {attempt}/{retries})"
            )
        except json.JSONDecodeError as exc:
            last_error = exc
            print(
                f"[WARN] 회차 {round_no} JSON 파싱 실패: {exc} "
                f"(시도 {attempt}/{retries})"
            )
        except TimeoutError as exc:
            last_error = exc
            print(
                f"[WARN] 회차 {round_no} 타임아웃 ({timeout}s) "
                f"(시도 {attempt}/{retries})"
            )
        except OSError as exc:
            # socket.timeout 등 urllib 내부 타임아웃도 OSError 계열
            last_error = exc
            print(
                f"[WARN] 회차 {round_no} I/O 오류: {exc} "
                f"(시도 {attempt}/{retries})"
            )

        if attempt < retries:
            time.sleep(DEFAULT_DELAY_SEC * attempt)

    print(f"[ERROR] 회차 {round_no} 최종 실패: {last_error}")
    return None


def draw_date_for_round(round_no: int) -> str:
    """회차별 추첨일(매주 토요일) 추정."""
    return (LOTTO_EPOCH_DATE + timedelta(days=7 * (round_no - 1))).isoformat()


def fetch_lottis_round(
    round_no: int,
    timeout: float,
    retries: int = MAX_RETRIES,
) -> Optional[Dict[str, str]]:
    """lottis.kr HTML 에서 당첨번호 파싱 (동행복권 API 차단 시 대안)."""
    url = LOTTIS_URL.format(round=round_no)
    last_error: Optional[Exception] = None

    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
                    ),
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "ko-KR,ko;q=0.9",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                html = resp.read().decode("utf-8", errors="replace")

            row = parse_lottis_html(html, round_no)
            if row is not None:
                return row

            last_error = ValueError("HTML에서 당첨번호 패턴 미발견")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            print(f"[WARN] lottis {round_no}회 ({attempt}/{retries}): {exc}")

        if attempt < retries:
            time.sleep(DEFAULT_DELAY_SEC * attempt)

    print(f"[ERROR] lottis {round_no}회 최종 실패: {last_error}")
    return None


def parse_lottis_html(html: str, round_no: int) -> Optional[Dict[str, str]]:
    """lottis 페이지 본문/제목에서 번호 6+보너스 추출."""
    patterns = [
        re.compile(
            rf"로또\s*{round_no}\s*회\s*당첨번호는\s*([\d,\s]+)이고,\s*보너스\s*번호는\s*(\d+)",
            re.I,
        ),
        re.compile(
            rf"제\s*{round_no}\s*회\s*로또\s*당첨번호\s*([\d,\s]+)\+(\d+)",
            re.I,
        ),
    ]
    for pat in patterns:
        m = pat.search(html)
        if not m:
            continue
        nums = [int(x.strip()) for x in m.group(1).split(",") if x.strip()]
        bonus = int(m.group(2))
        if len(nums) != 6:
            continue
        if len(set(nums)) != 6 or not all(1 <= n <= 45 for n in nums + [bonus]):
            continue
        return {
            "round": str(round_no),
            "draw_date": draw_date_for_round(round_no),
            "num1": str(nums[0]),
            "num2": str(nums[1]),
            "num3": str(nums[2]),
            "num4": str(nums[3]),
            "num5": str(nums[4]),
            "num6": str(nums[5]),
            "bonus": str(bonus),
        }
    return None


def fetch_round(
    round_no: int,
    timeout: float,
    source: SourceKind,
) -> Optional[Dict[str, str]]:
    """지정 소스로 한 회차 CSV 행 dict 반환."""
    if source == "lottis":
        return fetch_lottis_round(round_no, timeout)

    if source == "dhlottery":
        payload = fetch_lotto_round(round_no, timeout)
        if payload is None:
            return None
        try:
            return parse_row(payload)
        except ValueError:
            return None

    # auto: 동행복권 JSON 우선, 실패 시 lottis
    payload = fetch_lotto_round(round_no, timeout)
    if payload is not None:
        try:
            return parse_row(payload)
        except ValueError:
            pass
    return fetch_lottis_round(round_no, timeout)


def find_latest_round(timeout: float, delay: float, source: SourceKind) -> int:
    """이분 탐색으로 현재 공개된 최신 회차 번호를 찾는다."""
    low, high = 1, BINARY_SEARCH_HIGH
    latest = 0

    print("[INFO] 최신 회차 탐색 중 (이분 탐색)...")

    while low <= high:
        mid = (low + high) // 2
        data = fetch_round(mid, timeout, source)
        if data is not None:
            latest = mid
            low = mid + 1
        else:
            high = mid - 1
        time.sleep(delay * 0.5)  # 탐색 단계는 짧은 지연

    if latest < 1:
        raise RuntimeError("최신 회차를 찾지 못했습니다. API 접근을 확인하세요.")

    print(f"[INFO] 최신 회차: {latest}")
    return latest


# -----------------------------------------------------------------------------
# 데이터 변환 / CSV
# -----------------------------------------------------------------------------
def parse_row(payload: Dict[str, Any]) -> Dict[str, str]:
    """API 응답에서 CSV 한 행으로 변환. 필수 필드 누락 시 ValueError."""
    try:
        round_no = int(payload["drwNo"])
        draw_date = str(payload["drwNoDate"]).strip()
        nums = [
            int(payload[f"drwtNo{i}"]) for i in range(1, 7)
        ]
        bonus = int(payload["bnusNo"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"필수 필드 파싱 실패 (drwNo={payload.get('drwNo')}): {exc}") from exc

    for n in nums + [bonus]:
        if not (1 <= n <= 45):
            raise ValueError(f"번호 범위 오류: {n} (회차 {round_no})")

    return {
        "round": str(round_no),
        "draw_date": draw_date,
        "num1": str(nums[0]),
        "num2": str(nums[1]),
        "num3": str(nums[2]),
        "num4": str(nums[3]),
        "num5": str(nums[4]),
        "num6": str(nums[5]),
        "bonus": str(bonus),
    }


def load_existing_csv(path: Path) -> Tuple[Dict[int, Dict[str, str]], Set[int]]:
    """기존 CSV 를 읽어 round → row 맵과 회차 집합을 반환."""
    rows: Dict[int, Dict[str, str]] = {}
    if not path.is_file():
        return rows, set()

    with path.open("r", encoding="utf-8", newline="") as fp:
        reader = csv.DictReader(fp)
        if reader.fieldnames is None:
            return rows, set()

        for line_no, raw in enumerate(reader, start=2):
            try:
                r = int(raw["round"])
            except (KeyError, ValueError, TypeError):
                print(f"[WARN] CSV {path} {line_no}행: round 파싱 실패 → 스킵")
                continue
            rows[r] = {k: raw.get(k, "") for k in CSV_FIELDNAMES}

    return rows, set(rows.keys())


def write_csv(path: Path, rows_by_round: Dict[int, Dict[str, str]]) -> None:
    """회차 오름차순으로 CSV 전체를 다시 기록 (누적 병합 결과 반영)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sorted_rounds = sorted(rows_by_round.keys())

    with path.open("w", encoding="utf-8", newline="") as fp:
        writer = csv.DictWriter(fp, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        for r in sorted_rounds:
            writer.writerow(rows_by_round[r])


# -----------------------------------------------------------------------------
# 메인 크롤링 루프
# -----------------------------------------------------------------------------
def crawl(
    start_round: int,
    end_round: int,
    output_path: Path,
    delay: float,
    timeout: float,
    source: SourceKind,
    force: bool,
) -> Tuple[int, int, int]:
    """start_round ~ end_round 구간을 수집해 CSV 에 누적 적재.

    Returns:
        (신규 저장 건수, 갱신 건수, 실패 건수)
    """
    existing, _ = load_existing_csv(output_path)
    new_count = 0
    update_count = 0
    fail_count = 0
    total = end_round - start_round + 1

    print(
        f"[INFO] 수집 구간: {start_round}회 ~ {end_round}회 "
        f"(총 {total}회차, 기존 {len(existing)}건)"
    )
    print(f"[INFO] 출력 파일: {output_path.resolve()}")
    print(f"[INFO] 데이터 소스: {source}")
    print(f"[INFO] 요청 간 지연: {delay}s, 타임아웃: {timeout}s")

    try:
        for idx, round_no in enumerate(range(start_round, end_round + 1), start=1):
            print(f"[PROGRESS] ({idx}/{total}) {round_no}회차 요청 중...", end=" ")

            if round_no in existing and not force:
                print("이미 존재 → 스킵")
                continue

            row = fetch_round(round_no, timeout=timeout, source=source)
            if row is None:
                print("데이터 없음 또는 조회 실패")
                fail_count += 1
                time.sleep(delay)
                continue

            r_key = int(row["round"])
            if r_key in existing:
                existing[r_key] = row
                update_count += 1
                print("갱신")
            else:
                existing[r_key] = row
                new_count += 1
                print(
                    f"저장 OK | {row['draw_date']} | "
                    f"{row['num1']},{row['num2']},{row['num3']},"
                    f"{row['num4']},{row['num5']},{row['num6']} +{row['bonus']}"
                )

            if (new_count + update_count) > 0 and (new_count + update_count) % CHECKPOINT_EVERY == 0:
                write_csv(output_path, existing)
                print(f"[CHECKPOINT] 중간 저장 완료 (누적 {len(existing)}건)")

            time.sleep(delay)
    except KeyboardInterrupt:
        write_csv(output_path, existing)
        print("\n[INFO] Ctrl+C — 진행분 CSV 저장 후 종료")
        raise

    write_csv(output_path, existing)
    return new_count, update_count, fail_count


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    default_output = script_dir.parent / "data" / "lotto_history.csv"

    parser = argparse.ArgumentParser(
        description="동행복권 당첨 데이터를 수집하여 lotto_history.csv 에 적재합니다."
    )
    parser.add_argument(
        "--start",
        type=int,
        default=1,
        help="시작 회차 (기본: 1)",
    )
    parser.add_argument(
        "--end",
        type=int,
        default=None,
        help="종료 회차 (미지정 시 API 로 최신 회차 자동 탐색)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_output,
        help=f"CSV 출력 경로 (기본: {default_output})",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY_SEC,
        help=f"API 호출 간 지연 초 (기본: {DEFAULT_DELAY_SEC})",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SEC,
        help=f"HTTP 타임아웃 초 (기본: {DEFAULT_TIMEOUT_SEC})",
    )
    parser.add_argument(
        "--skip-latest-search",
        action="store_true",
        help="--end 가 없을 때 최신 회차 이분 탐색 생략 (start 만 수집)",
    )
    parser.add_argument(
        "--source",
        choices=("auto", "dhlottery", "lottis"),
        default="auto",
        help="수집 소스 (auto=동행복권 후 lottis 폴백, 권장: lottis)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="이미 CSV에 있는 회차도 다시 수집",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.start < 1:
        print("[ERROR] --start 는 1 이상이어야 합니다.", file=sys.stderr)
        return 1
    if args.delay < 0:
        print("[ERROR] --delay 는 0 이상이어야 합니다.", file=sys.stderr)
        return 1
    if args.timeout <= 0:
        print("[ERROR] --timeout 은 0보다 커야 합니다.", file=sys.stderr)
        return 1

    try:
        if args.end is not None:
            end_round = args.end
        elif args.skip_latest_search:
            print("[ERROR] --end 또는 최신 회차 탐색이 필요합니다.", file=sys.stderr)
            return 1
        else:
            end_round = find_latest_round(
                timeout=args.timeout, delay=args.delay, source=args.source
            )

        if args.start > end_round:
            print(
                f"[ERROR] 시작 회차({args.start})가 종료 회차({end_round})보다 큽니다.",
                file=sys.stderr,
            )
            return 1

        try:
            new_c, upd_c, fail_c = crawl(
                start_round=args.start,
                end_round=end_round,
                output_path=args.output,
                delay=args.delay,
                timeout=args.timeout,
                source=args.source,
                force=args.force,
            )
        except KeyboardInterrupt:
            # crawl() 내부에서 이미 진행분 저장 후 재발생
            return 130

        print("=" * 60)
        print("[DONE] 크롤링 완료")
        print(f"  신규: {new_c}건 | 갱신: {upd_c}건 | 실패/누락: {fail_c}건")
        print(f"  파일: {args.output.resolve()}")
        print("=" * 60)
        return 0 if fail_c == 0 else 2

    except KeyboardInterrupt:
        print("\n[INFO] 사용자 중단.")
        return 130
    except RuntimeError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
