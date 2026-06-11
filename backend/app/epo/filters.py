"""통계 필터 — 각 함수는 순수(predicate) 또는 메트릭 측정 함수.

본 모듈에는 다음이 포함된다:
  - 조합 특성 측정 함수 (sum_total, odd_count, ac_value, ...)
  - 측정 함수를 임계값과 결합한 predicate factory (passes_*)

predicate factory 패턴을 채택한 이유:
  - 파이프라인에서 사용자별 파라미터(상한/하한)를 자유롭게 주입 가능
  - 각 predicate 가 독립적으로 단위 테스트 가능
  - filter chain 의 순서를 외부에서 재구성 가능 (확장성)
"""
from __future__ import annotations

from typing import Callable, Iterable

Combo = tuple[int, ...]
Predicate = Callable[[Combo], bool]

# 고/저 번호 분기 임계값. 1~22 = 저, 23~45 = 고 (대칭 분할에 가장 근접).
HIGH_THRESHOLD = 23


# ── 메트릭 측정 함수 ─────────────────────────────────────────
def sum_total(combo: Combo) -> int:
    """6개 번호 총합."""
    return int(sum(combo))


def odd_count(combo: Combo) -> int:
    """홀수 개수 (0~6)."""
    return sum(1 for n in combo if n % 2 == 1)


def even_count(combo: Combo) -> int:
    """짝수 개수 = 6 - odd_count."""
    return len(combo) - odd_count(combo)


def high_count(combo: Combo, threshold: int = HIGH_THRESHOLD) -> int:
    """threshold 이상 번호 개수 (기본 23 이상)."""
    return sum(1 for n in combo if n >= threshold)


def max_consecutive_run(combo: Combo) -> int:
    """연속된 번호의 최대 길이. 예: (3,4,5,8,9,30) → 3."""
    nums = sorted(combo)
    if not nums:
        return 0
    longest = current = 1
    for i in range(1, len(nums)):
        if nums[i] - nums[i - 1] == 1:
            current += 1
            longest = max(longest, current)
        else:
            current = 1
    return longest


def ac_value(combo: Combo) -> int:
    """Arithmetic Complexity (AC 값).

    정의: AC = (조합 내 모든 쌍의 양의 차이값 종류 수) - (k - 1)
    여기서 k = 6. 최대값 = C(6,2) - 5 = 10.
    역사적 1등 조합의 90% 이상이 AC ≥ 7.
    AC 가 낮으면 등차수열 등 '구조적' 조합 → 통계적 희박.
    """
    nums = sorted(combo)
    diffs: set[int] = set()
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            diffs.add(nums[j] - nums[i])
    return len(diffs) - (len(nums) - 1)


def decade_buckets(combo: Combo) -> dict[int, int]:
    """십의자리 그룹별 개수. 키: 0(1~9), 1(10~19), 2(20~29), 3(30~39), 4(40~45)."""
    buckets = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0}
    for n in combo:
        bucket = min(n // 10, 4)
        buckets[bucket] += 1
    return buckets


def max_same_decade(combo: Combo) -> int:
    """가장 많이 몰린 십의자리 그룹의 개수."""
    return max(decade_buckets(combo).values())


def last_digit_unique(combo: Combo) -> int:
    """끝자리 종류 수 (0~9 중)."""
    return len({n % 10 for n in combo})


def overlap_count(combo: Combo, other: Iterable[int]) -> int:
    """다른 조합과의 공통 번호 개수."""
    return len(set(combo) & set(other))


# ── Predicate Factories ─────────────────────────────────────
def passes_sum_range(lo: int, hi: int) -> Predicate:
    """Filter 1a: 총합이 [lo, hi] 폐구간 안에 있는지."""
    def predicate(combo: Combo) -> bool:
        return lo <= sum_total(combo) <= hi
    return predicate


def passes_min_ac(min_ac: int) -> Predicate:
    """Filter 1b: AC 값이 min_ac 이상인지 (구조적 조합 배제)."""
    def predicate(combo: Combo) -> bool:
        return ac_value(combo) >= min_ac
    return predicate


def passes_odd_count(allowed: set[int]) -> Predicate:
    """Filter 2a: 홀수 개수가 허용 집합 안에 있는지. 예: {2, 3, 4}."""
    frozen = frozenset(allowed)
    def predicate(combo: Combo) -> bool:
        return odd_count(combo) in frozen
    return predicate


def passes_high_count(allowed: set[int], threshold: int = HIGH_THRESHOLD) -> Predicate:
    """Filter 2b: 고번호(>=threshold) 개수가 허용 집합 안에 있는지."""
    frozen = frozenset(allowed)
    def predicate(combo: Combo) -> bool:
        return high_count(combo, threshold) in frozen
    return predicate


def passes_max_run(max_run: int) -> Predicate:
    """Filter 3: 연속 번호 최대 길이가 max_run 이하인지."""
    def predicate(combo: Combo) -> bool:
        return max_consecutive_run(combo) <= max_run
    return predicate


def passes_last_round_overlap(last: Iterable[int], max_overlap: int) -> Predicate:
    """Filter 4: 직전 회차 조합과의 오버랩이 max_overlap 이하인지."""
    last_set = frozenset(last)
    def predicate(combo: Combo) -> bool:
        return len(set(combo) & last_set) <= max_overlap
    return predicate


def passes_decade_balance(max_same: int) -> Predicate:
    """Filter 5a: 동일 십의자리 그룹에 max_same 초과 몰리지 않는지."""
    def predicate(combo: Combo) -> bool:
        return max_same_decade(combo) <= max_same
    return predicate


def passes_last_digit_variety(min_unique: int) -> Predicate:
    """Filter 5b: 끝자리 종류가 min_unique 이상인지."""
    def predicate(combo: Combo) -> bool:
        return last_digit_unique(combo) >= min_unique
    return predicate
