#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
로또 추첨기(호기)별 패턴 분석 및 알고리즘 기반 추천 번호 생성 (표준 라이브러리 전용).

[의존성] csv, collections, random, datetime, argparse, statistics (내장)
[입력]   lotto_history.csv - round, draw_date, num1~num6, bonus

[실행]
  python analyze_machine_patterns.py
  python analyze_machine_patterns.py --csv ../data/lotto_history.csv --machine 2
  python analyze_machine_patterns.py --machine auto --seed 7 --no-prompt
"""
from __future__ import annotations

import argparse
import csv
import random
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from itertools import combinations
from pathlib import Path
from statistics import mean
from typing import Dict, List, Optional, Sequence, Set, Tuple

# =============================================================================
# 1. 가변형 호기 매핑 메타데이터 (상단 집중 관리)
# =============================================================================
# 동행복권은 통상 1~2개월 또는 분기 단위로 1·2·3호 추첨기를 교체합니다.
# CSV에 호기 컬럼이 없으므로 (연도, 월) 또는 (연도, 분기) 기준으로 '예상 호기'를 부여합니다.
# 공식 교체 일정이 발표되면 아래 딕셔너리만 수정하면 전체 파이프라인에 반영됩니다.

ALL_NUMBERS: Tuple[int, ...] = tuple(range(1, 46))
VALID_MACHINE_IDS: Tuple[int, ...] = (1, 2, 3)

# 분기별 호기 지정 (가설/보정) — 키: (연도, 분기 1~4), 값: 호기 번호 1|2|3
QUARTER_TO_MACHINE: Dict[Tuple[int, int], int] = {
    (2023, 1): 2,
    (2023, 2): 3,
    (2023, 3): 1,
    (2023, 4): 2,
    (2024, 1): 3,
    (2024, 2): 1,
    (2024, 3): 2,
    (2024, 4): 3,
    (2025, 1): 1,
    (2025, 2): 2,
    (2025, 3): 3,
    (2025, 4): 1,
    (2026, 1): 2,
    (2026, 2): 3,
}

# 월별 호기 힌트 (1~2달 단위 교체 가설, 분기 테이블에 없을 때 보조)
MONTH_TO_MACHINE: Dict[Tuple[int, int], int] = {
    (2024, 1): 3,
    (2024, 2): 3,
    (2024, 3): 1,
    (2024, 4): 1,
    (2024, 5): 2,
    (2024, 6): 2,
    (2024, 7): 2,
    (2024, 8): 3,
    (2024, 9): 3,
    (2024, 10): 3,
    (2024, 11): 2,
    (2024, 12): 2,
}

# 순환 앵커: 2002년 1분기부터 1호기 -> 2호기 -> 3호기 -> 1호기 ... (분기 단위)
CYCLE_ANCHOR: Tuple[int, int, int] = (2002, 1, 1)  # (년, 분기, 시작 호기 번호)

# 로또 기본 필터 (추천 조합 검증용)
SUM_MIN = 100
SUM_MAX = 175
VALID_ODD_COUNTS: Tuple[int, ...] = (2, 3, 4)  # 홀수 개수 -> 짝수는 4:2, 3:3, 2:4

NUM_GAMES = 5
MAX_BUILD_ATTEMPTS = 300


# =============================================================================
# 2. 데이터 모델
# =============================================================================
@dataclass(frozen=True)
class LottoDraw:
    """단일 회차 레코드."""

    round: int
    draw_date: date
    numbers: Tuple[int, int, int, int, int, int]
    bonus: int
    machine_id: int = 0  # 1, 2, 3

    @property
    def sorted_numbers(self) -> Tuple[int, ...]:
        return tuple(sorted(self.numbers))

    @property
    def sum_total(self) -> int:
        return sum(self.numbers)

    @property
    def odd_count(self) -> int:
        return sum(1 for n in self.numbers if n % 2 == 1)


@dataclass
class MachineAnalysis:
    """특정 호기에 대한 종합 분석 결과."""

    machine_id: int
    draw_count: int = 0
    # 출현 빈도 순위 (번호, 횟수) — 많을수록 '핫'
    frequency_rank: List[Tuple[int, int]] = field(default_factory=list)
    # 미출현 기간: (번호, 마지막 출현 이후 경과 회차 수) — 클수록 '콜드'
    absence_rank: List[Tuple[int, int]] = field(default_factory=list)
    # 연번 쌍 (n, n+1) 동일 회차 동시 출현 빈도
    consecutive_pairs: List[Tuple[Tuple[int, int], int]] = field(default_factory=list)
    # 궁합수: 서로 다른 두 번호가 같은 회차에 함께 나온 빈도
    pair_synergy: List[Tuple[Tuple[int, int], int]] = field(default_factory=list)
    avg_sum: float = 0.0
    avg_odd: float = 0.0


# =============================================================================
# 3. CSV 로더
# =============================================================================
class LottoCsvLoader:
    """lotto_history.csv 파싱."""

    COLUMNS = (
        "round",
        "draw_date",
        "num1",
        "num2",
        "num3",
        "num4",
        "num5",
        "num6",
        "bonus",
    )

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> List[LottoDraw]:
        if not self.path.is_file():
            raise FileNotFoundError(f"CSV 없음: {self.path}")

        rows: List[LottoDraw] = []
        with self.path.open("r", encoding="utf-8", newline="") as fp:
            reader = csv.DictReader(fp)
            if not reader.fieldnames:
                raise ValueError("CSV 헤더가 비어 있습니다.")
            missing = set(self.COLUMNS) - set(reader.fieldnames)
            if missing:
                raise ValueError(f"필수 컬럼 누락: {sorted(missing)}")

            for line_no, raw in enumerate(reader, start=2):
                try:
                    rows.append(self._parse(raw))
                except ValueError as exc:
                    print(f"[WARN] {line_no}행 스킵: {exc}")

        if not rows:
            raise ValueError(
                f"유효 데이터 없음. crawl_lotto_history.py 로 {self.path} 를 채워 주세요."
            )
        rows.sort(key=lambda d: d.round)
        return rows

    @staticmethod
    def _parse(raw: Dict[str, str]) -> LottoDraw:
        r = int(raw["round"].strip())
        d = datetime.strptime(raw["draw_date"].strip(), "%Y-%m-%d").date()
        nums = tuple(int(raw[f"num{i}"].strip()) for i in range(1, 7))
        bonus = int(raw["bonus"].strip())
        if len(set(nums)) != 6:
            raise ValueError(f"{r}회: 당첨번호 중복")
        for n in list(nums) + [bonus]:
            if not (1 <= n <= 45):
                raise ValueError(f"{r}회: 번호 범위 오류 {n}")
        return LottoDraw(round=r, draw_date=d, numbers=nums, bonus=bonus)


# =============================================================================
# 4. 호기 매핑 (가변형)
# =============================================================================
class MachineMapper:
    """추첨일 기준 예상 호기(1~3) 분류."""

    @staticmethod
    def quarter(d: date) -> int:
        return (d.month - 1) // 3 + 1

    @classmethod
    def from_date(cls, d: date) -> int:
        """우선순위: (년,분기) 테이블 > (년,월) 테이블 > 분기 순환."""
        q_key = (d.year, cls.quarter(d))
        if q_key in QUARTER_TO_MACHINE:
            return QUARTER_TO_MACHINE[q_key]

        m_key = (d.year, d.month)
        if m_key in MONTH_TO_MACHINE:
            return MONTH_TO_MACHINE[m_key]

        anchor_y, anchor_q, anchor_m = CYCLE_ANCHOR
        offset = (d.year - anchor_y) * 4 + (cls.quarter(d) - anchor_q)
        return ((anchor_m - 1 + offset) % 3) + 1

    @classmethod
    def predict_next_date(cls, draws: Sequence[LottoDraw]) -> date:
        """다음 회차 예상 추첨일 (최신일 + 7일, 토요 추첨 가정)."""
        latest = max(d.draw_date for d in draws)
        return latest + timedelta(days=7)

    @classmethod
    def predict_next_machine(cls, draws: Sequence[LottoDraw]) -> int:
        return cls.from_date(cls.predict_next_date(draws))


def attach_machine_ids(draws: List[LottoDraw]) -> List[LottoDraw]:
    """각 회차에 machine_id 부여 (frozen dataclass 재생성)."""
    out: List[LottoDraw] = []
    for d in draws:
        mid = MachineMapper.from_date(d.draw_date)
        out.append(
            LottoDraw(
                round=d.round,
                draw_date=d.draw_date,
                numbers=d.numbers,
                bonus=d.bonus,
                machine_id=mid,
            )
        )
    return out


def prompt_machine_id(auto_id: int, no_prompt: bool, cli_machine: Optional[int]) -> int:
    """사용자 호기 선택: CLI 우선, 없으면 input(), Enter 시 자동."""
    if cli_machine is not None:
        if cli_machine not in VALID_MACHINE_IDS:
            raise ValueError("호기는 1, 2, 3 중 하나여야 합니다.")
        return cli_machine

    if no_prompt:
        return auto_id

    print()
    print("=" * 56)
    print("  이번 회차 분석에 사용할 호기(추첨기)를 선택하세요.")
    print(f"  [Enter] 자동 예측: {auto_id}호기")
    print("  직접 입력: 1 / 2 / 3")
    print("=" * 56)
    try:
        raw = input("호기 입력 >> ").strip()
    except EOFError:
        raw = ""

    if raw == "":
        print(f"[INFO] 자동 예측 호기 적용: {auto_id}호기")
        return auto_id

    if raw not in ("1", "2", "3"):
        print(f"[WARN] 잘못된 입력 '{raw}' -> 자동 예측 {auto_id}호기 사용")
        return auto_id

    chosen = int(raw)
    print(f"[INFO] 사용자 지정 호기: {chosen}호기")
    return chosen


# =============================================================================
# 5. 패턴 분석기
# =============================================================================
class MachinePatternAnalyzer:
    """선택 호기에 대한 빈도·미출현·연번·궁합수 분석."""

    def __init__(self, draws: Sequence[LottoDraw], machine_id: int) -> None:
        self.machine_id = machine_id
        self.draws = sorted(
            [d for d in draws if d.machine_id == machine_id],
            key=lambda x: x.round,
        )

    def analyze(self) -> MachineAnalysis:
        if not self.draws:
            return MachineAnalysis(machine_id=self.machine_id, draw_count=0)

        freq: Counter[int] = Counter()
        consec: Counter[Tuple[int, int]] = Counter()
        synergy: Counter[Tuple[int, int]] = Counter()
        last_seen: Dict[int, int] = {}
        sums: List[int] = []
        odds: List[int] = []

        for d in self.draws:
            for n in d.numbers:
                freq[n] += 1
                last_seen[n] = d.round

            sorted_nums = d.sorted_numbers
            for i in range(len(sorted_nums) - 1):
                if sorted_nums[i + 1] - sorted_nums[i] == 1:
                    consec[(sorted_nums[i], sorted_nums[i + 1])] += 1

            for pair in combinations(d.numbers, 2):
                synergy[tuple(sorted(pair))] += 1

            sums.append(d.sum_total)
            odds.append(d.odd_count)

        max_round = self.draws[-1].round
        absence: List[Tuple[int, int]] = []
        for n in ALL_NUMBERS:
            if n in last_seen:
                gap = max_round - last_seen[n]
            else:
                gap = max_round  # 한 번도 안 나온 경우 최대 간격
            absence.append((n, gap))

        absence.sort(key=lambda x: (-x[1], x[0]))
        frequency = freq.most_common()

        return MachineAnalysis(
            machine_id=self.machine_id,
            draw_count=len(self.draws),
            frequency_rank=frequency,
            absence_rank=absence,
            consecutive_pairs=consec.most_common(),
            pair_synergy=synergy.most_common(),
            avg_sum=round(mean(sums), 1),
            avg_odd=round(mean(odds), 2),
        )


# =============================================================================
# 6. 추천 조합 생성 (고빈도 3 + 미출현 1 + 궁합/연번 2) + 필터
# =============================================================================
class CombinationFilter:
    """로또 기본 필터: 총합 100~175, 홀짝 2:4 / 3:3 / 4:2."""

    @staticmethod
    def is_valid(nums: Sequence[int]) -> bool:
        if len(nums) != 6 or len(set(nums)) != 6:
            return False
        total = sum(nums)
        if total < SUM_MIN or total > SUM_MAX:
            return False
        odd = sum(1 for n in nums if n % 2 == 1)
        return odd in VALID_ODD_COUNTS


class RecommendationEngine:
    """
    구성 규칙 (6개 번호):
      - 고빈도수 3개: 해당 호기 출현 빈도 상위 풀에서 선택
      - 미출현수 1개: 미출현 기간(경과 회차)이 긴 상위 풀에서 선택
      - 궁합/연번 2개: 연번 쌍 우선, 없으면 궁합수 상위 쌍에서 번호 추출
    이후 CombinationFilter 로 검증, 실패 시 재조합.
    """

    def __init__(self, analysis: MachineAnalysis, rng: random.Random) -> None:
        self.analysis = analysis
        self.rng = rng
        self.hot_pool = [n for n, _ in analysis.frequency_rank[:15]]
        self.cold_pool = [n for n, _ in analysis.absence_rank[:15]]
        self.top_pairs = self._merge_pair_candidates()

    def _merge_pair_candidates(self) -> List[Tuple[int, int]]:
        """연번 쌍 + 궁합수 쌍을 점수 순으로 통합."""
        scored: Dict[Tuple[int, int], int] = {}
        for pair, cnt in self.analysis.consecutive_pairs:
            scored[pair] = scored.get(pair, 0) + cnt * 2
        for pair, cnt in self.analysis.pair_synergy:
            scored[pair] = scored.get(pair, 0) + cnt
        ranked = sorted(scored.items(), key=lambda x: (-x[1], x[0]))
        return [p for p, _ in ranked[:12]]

    def generate(self, count: int = NUM_GAMES) -> List[List[int]]:
        if self.analysis.draw_count == 0:
            return []

        games: List[List[int]] = []
        attempts = 0
        while len(games) < count and attempts < MAX_BUILD_ATTEMPTS * count:
            attempts += 1
            combo = self._build_one()
            if combo is None:
                continue
            sorted_combo = sorted(combo)
            if sorted_combo not in games:
                games.append(sorted_combo)
        return games

    def _build_one(self) -> Optional[List[int]]:
        chosen: Set[int] = set()

        hot_src = self.hot_pool or list(ALL_NUMBERS)
        cold_src = self.cold_pool or list(ALL_NUMBERS)

        # (1) 고빈도 3개
        hot_pick = self._sample_unique(hot_src, 3, chosen)
        if hot_pick is None:
            return None
        chosen.update(hot_pick)

        # (2) 미출현 1개
        cold_candidates = [n for n in cold_src if n not in chosen]
        if not cold_candidates:
            cold_candidates = [n for n in ALL_NUMBERS if n not in chosen]
        cold_n = self.rng.choice(cold_candidates)
        chosen.add(cold_n)

        # (3) 궁합/연번 2개
        if not self._add_pair_numbers(chosen, need=2):
            extra = self._sample_unique(hot_src + cold_src, 2, chosen)
            if extra is None:
                return None
            chosen.update(extra)

        if len(chosen) != 6:
            return None

        nums = sorted(chosen)
        if CombinationFilter.is_valid(nums):
            return nums
        return None

    def _add_pair_numbers(self, chosen: Set[int], need: int) -> bool:
        """연번/궁합 쌍에서 아직 선택되지 않은 번호를 최대 need 개 채운다."""
        added = 0
        pairs = list(self.top_pairs)
        self.rng.shuffle(pairs)
        for a, b in pairs:
            for n in (a, b):
                if n not in chosen and added < need:
                    chosen.add(n)
                    added += 1
            if added >= need:
                return True
        return added >= need

    def _sample_unique(
        self,
        pool: Sequence[int],
        k: int,
        exclude: Set[int],
    ) -> Optional[List[int]]:
        candidates = [n for n in pool if n not in exclude]
        if len(candidates) < k:
            candidates = [n for n in ALL_NUMBERS if n not in exclude]
        if len(candidates) < k:
            return None
        return self.rng.sample(candidates, k)


# =============================================================================
# 7. 콘솔 리포트
# =============================================================================
class ConsoleReporter:
    """분석 요약 및 추천 5게임 출력."""

    WIDTH = 58

    @classmethod
    def _line(cls, char: str = "=") -> None:
        print(char * cls.WIDTH)

    def print_machine_summary(self, stats: MachineAnalysis) -> None:
        """① 선택 호기 통계 요약."""
        mid = stats.machine_id
        print()
        self._line()
        print(f"  [{mid}호기] 주요 통계 요약".center(self.WIDTH))
        self._line()
        print(f"  분석 대상 회차: {stats.draw_count}회")
        print(f"  평균 총합: {stats.avg_sum}  |  평균 홀수 개수: {stats.avg_odd}")
        print()

        print("  [최다 출현 TOP 5]")
        if stats.frequency_rank:
            for i, (num, cnt) in enumerate(stats.frequency_rank[:5], 1):
                print(f"    {i}. 번호 {num:2d}  -  {cnt}회")
        else:
            print("    (데이터 없음)")

        print()
        print("  [최저 출현 / 미출현 기간 TOP 5]")
        if stats.absence_rank:
            for i, (num, gap) in enumerate(stats.absence_rank[:5], 1):
                print(f"    {i}. 번호 {num:2d}  -  {gap}회차째 미출현(추정)")
        else:
            print("    (데이터 없음)")

        print()
        print("  [연번 쌍 TOP 3]")
        for (a, b), cnt in stats.consecutive_pairs[:3]:
            print(f"    ({a:2d}, {b:2d})  -  동회차 {cnt}회")
        if not stats.consecutive_pairs:
            print("    (없음)")

        print()
        print("  [궁합수 TOP 3]")
        for (a, b), cnt in stats.pair_synergy[:3]:
            print(f"    ({a:2d}, {b:2d})  -  동시 출현 {cnt}회")
        if not stats.pair_synergy:
            print("    (없음)")
        self._line()

    def print_recommendations(
        self,
        machine_id: int,
        games: List[List[int]],
    ) -> None:
        """② 최종 추천 5게임 (오름차순)."""
        print()
        self._line()
        print(f"  [다음 회차 추천 번호 - {machine_id}호기 기반]".center(self.WIDTH))
        self._line()
        print("  구성: 고빈도 3 + 미출현 1 + 궁합/연번 2")
        print(f"  필터: 총합 {SUM_MIN}~{SUM_MAX}, 홀짝 (2:4)|(3:3)|(4:2)")
        print()

        if not games:
            print("  [WARN] 조건을 만족하는 조합을 생성하지 못했습니다.")
        else:
            for i, nums in enumerate(games, 1):
                line = "  ".join(f"{n:02d}" for n in nums)
                odd = sum(1 for n in nums if n % 2 == 1)
                print(
                    f"  게임 {i} :  {line}  "
                    f"(합:{sum(nums)}, 홀{odd}:짝{6 - odd})"
                )

        print()
        print("  * 통계 참고용이며 당첨을 보장하지 않습니다.")
        self._line()


# =============================================================================
# 8. 애플리케이션 오케스트레이션
# =============================================================================
class LottoAnalyzerApp:
    """전체 실행 파이프라인."""

    def __init__(
        self,
        csv_path: Path,
        seed: Optional[int],
        machine_arg: Optional[str],
        no_prompt: bool,
    ) -> None:
        self.csv_path = csv_path
        self.rng = random.Random(seed)
        self.machine_arg = machine_arg
        self.no_prompt = no_prompt

    def run(self) -> int:
        draws = attach_machine_ids(LottoCsvLoader(self.csv_path).load())
        latest = draws[-1]
        auto_machine = MachineMapper.predict_next_machine(draws)
        next_date = MachineMapper.predict_next_date(draws)

        cli_machine: Optional[int] = None
        if self.machine_arg and self.machine_arg != "auto":
            cli_machine = int(self.machine_arg)

        target_machine = prompt_machine_id(
            auto_id=auto_machine,
            no_prompt=self.no_prompt,
            cli_machine=cli_machine,
        )

        print()
        print("로또 호기 패턴 분석기".center(ConsoleReporter.WIDTH))
        print(f"  데이터: {self.csv_path.name} ({len(draws)}회차)")
        print(
            f"  최신: {latest.round}회 ({latest.draw_date}) "
            f"-> 예상 {latest.machine_id}호기"
        )
        print(
            f"  다음: {latest.round + 1}회 ({next_date}) "
            f"-> 자동예측 {auto_machine}호기 | 분석대상 {target_machine}호기"
        )

        analysis = MachinePatternAnalyzer(draws, target_machine).analyze()
        if analysis.draw_count == 0:
            print(
                f"[ERROR] {target_machine}호기에 해당하는 회차가 없습니다. "
                "다른 호기를 선택하거나 CSV 데이터를 늘려 주세요.",
                file=sys.stderr,
            )
            return 1

        reporter = ConsoleReporter()
        reporter.print_machine_summary(analysis)

        engine = RecommendationEngine(analysis, self.rng)
        games = engine.generate(NUM_GAMES)
        reporter.print_recommendations(target_machine, games)
        return 0


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    default_csv = script_dir.parent / "data" / "lotto_history.csv"
    parser = argparse.ArgumentParser(
        description="호기별 패턴 분석 및 필터링된 추천 번호 생성"
    )
    parser.add_argument("--csv", type=Path, default=default_csv)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument(
        "--machine",
        type=str,
        default=None,
        help="1|2|3 또는 auto (미지정 시 실행 중 input)",
    )
    parser.add_argument(
        "--no-prompt",
        action="store_true",
        help="호기 input() 없이 자동 예측 호기 사용",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        return LottoAnalyzerApp(
            csv_path=args.csv,
            seed=args.seed,
            machine_arg=args.machine,
            no_prompt=args.no_prompt,
        ).run()
    except (FileNotFoundError, ValueError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[INFO] 중단됨.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
