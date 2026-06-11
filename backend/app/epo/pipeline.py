"""제너레이터 기반 후보 스트림 — Multi-Stage Filter Pipeline.

본 모듈은 메모리 효율을 위해 무한 이터레이터 패턴을 채택한다.
대량 조합 생성 요청에서도 후보 전체를 메모리에 적재하지 않으며,
필터가 너무 좁아 합격자가 없는 경우에도 max_attempts 안전망으로 보호.

파이프라인:
    candidate_stream  →  filter_stream  →  take_diverse
    (가중치 비복원 추출)  (predicate 통과)  (게임간 다양성)
"""
from __future__ import annotations

from typing import Callable, Iterator

import numpy as np

Combo = tuple[int, ...]
Predicate = Callable[[Combo], bool]

ALL_NUMBERS = np.arange(1, 46, dtype=int)


def candidate_stream(
    rng: np.random.Generator,
    weights: np.ndarray,
) -> Iterator[Combo]:
    """45 번호 풀에서 가중치 기반 비복원 6개 추출 — 무한 yield.

    weights 의 shape 은 (45,) 이며 합 ≈ 1 이어야 한다.
    출력 combo 는 항상 오름차순 정렬된 tuple[int].
    """
    if weights.shape != (45,):
        raise ValueError(f"weights shape must be (45,), got {weights.shape}")

    while True:
        picked = rng.choice(ALL_NUMBERS, size=6, replace=False, p=weights)
        yield tuple(int(x) for x in sorted(picked))


def filter_stream(
    stream: Iterator[Combo],
    predicates: list[Predicate],
) -> Iterator[Combo]:
    """모든 predicate 를 통과하는 조합만 yield (지연 평가)."""
    for combo in stream:
        if all(p(combo) for p in predicates):
            yield combo


def take_diverse(
    stream: Iterator[Combo],
    n: int,
    max_overlap: int = 3,
    max_attempts: int = 200_000,
) -> tuple[list[Combo], int]:
    """필터 통과 스트림에서 게임 간 다양성을 유지하며 N개 선택.

    다양성 정책:
      - 동일 조합 중복 금지
      - 선택된 모든 조합과의 페어와이즈 공통 번호 ≤ max_overlap

    Args:
        stream: filter_stream 출력 (지연 평가).
        n: 목표 조합 수.
        max_overlap: 선택된 조합과 새 후보 간 허용 공통 번호 수.
        max_attempts: 안전망 — 이 횟수를 넘으면 부분 결과 반환.

    Returns:
        (선택된 조합 리스트, 실제 시도 횟수)
    """
    if n <= 0:
        return [], 0

    selected: list[Combo] = []
    seen: set[Combo] = set()
    attempts = 0

    for combo in stream:
        attempts += 1
        if attempts > max_attempts:
            break

        if combo in seen:
            continue

        # diversity 제약: 기존 선택과의 페어와이즈 오버랩 검사
        if all(len(set(combo) & set(s)) <= max_overlap for s in selected):
            selected.append(combo)
            seen.add(combo)
            if len(selected) >= n:
                break

    return selected, attempts
