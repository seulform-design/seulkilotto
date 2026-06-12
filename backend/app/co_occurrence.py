"""번호 동반 출현 분석 (Co-Occurrence).

각 번호 1~45 에 대해, 같은 회차에 함께 출현했던 다른 번호의
빈도/신뢰도/리프트를 산출한다.

수학적 정직 선언:
  - 본 분석은 '과거 회차에서 어느 쌍이 함께 나왔는지' 의 묘사 통계.
  - 독립시행 정의상, 다음 회차에서 17번이 나온다 해도 23번이 함께 나올
    확률은 다른 어떤 번호와도 동일하다 (1227회 표본 노이즈일 뿐).
  - 우리는 lift 와 baseline 을 함께 노출하여 사용자가 통계적
    유의성을 스스로 가늠할 수 있게 한다.

지표 정의 (a, b ∈ {1,...,45}, a ≠ b):
  - count(a, b)     = 같은 회차에 a, b 둘 다 등장한 회차 수
  - support(a, b)   = count(a, b) / total_rounds
  - confidence(b|a) = count(a, b) / appearance(a) ≈ P(b 같이 출현 | a 출현)
  - lift(a, b)      = support(a, b) / (support(a) * support(b))
                    = actual / expected_under_independence
                    > 1 이면 양의 상관, < 1 이면 음의 상관
  - 무작위 베이스라인 confidence ≈ 5/44 ≈ 11.36% (a가 나왔을 때 b 가 함께일 확률)
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

import numpy as np
import pandas as pd

from . import database

DEFAULT_TOP_N: int = 20
BASELINE_CONFIDENCE: float = 5.0 / 44.0  # 한 자리가 a 로 차고 나머지 5/44 중 b
LIFT_SIGNIFICANT_THRESHOLD: float = 1.20
COUNT_SIGNIFICANT_MIN: int = 30

DISCLAIMER: str = (
    "동반 출현 분석은 과거 회차에서 어느 번호 쌍이 함께 나왔는지를 측정한 묘사 통계입니다. "
    "독립시행 정의상 다음 회차의 출현 확률은 모든 쌍에 동일합니다. "
    "본 분석은 패턴 관찰용이며 예측이 아닙니다. "
    f"무작위 베이스라인 동반 확률 = {BASELINE_CONFIDENCE:.1%}."
)


@dataclass
class Partner:
    number: int  # 동반 출현한 번호
    count: int  # 함께 등장한 회차 수
    confidence: float  # P(이 번호 | source 출현)
    lift: float  # actual / expected (1.0 = 독립)
    is_significant: bool  # lift 와 count 가 모두 기준 충족


@dataclass
class CoOccurrenceSummary:
    total_rounds: int
    appearance_counts: dict[int, int]
    baseline_confidence: float
    top_n: int
    partners: dict[int, list[Partner]]
    disclaimer: str


def _build_matrix(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """45x45 co-occurrence 행렬 + 각 번호 출현 카운트 (1-indexed, [0] 무시).

    Returns:
        co (46x46): co[a][b] = a, b 함께 등장 회차 수 (대칭)
        appearance (46,): appearance[a] = a 가 등장한 회차 수
    """
    co = np.zeros((46, 46), dtype=np.int32)
    appearance = np.zeros(46, dtype=np.int32)

    nums_arr = df[database.NUMBER_COLUMNS].to_numpy(dtype=int)
    for row in nums_arr:
        # 유효 번호만 (1~45)
        valid = sorted({int(n) for n in row if 1 <= int(n) <= 45})
        for n in valid:
            appearance[n] += 1
        for a, b in combinations(valid, 2):
            co[a][b] += 1
            co[b][a] += 1

    return co, appearance


def compute_co_occurrence(
    df: pd.DataFrame,
    top_n: int = DEFAULT_TOP_N,
) -> CoOccurrenceSummary:
    """전체 회차로부터 1~45 각 번호의 동반 출현 통계 산출."""
    if df is None or df.empty:
        return CoOccurrenceSummary(
            total_rounds=0,
            appearance_counts={n: 0 for n in range(1, 46)},
            baseline_confidence=BASELINE_CONFIDENCE,
            top_n=top_n,
            partners={n: [] for n in range(1, 46)},
            disclaimer=DISCLAIMER,
        )

    total_rounds = int(len(df))
    co, appearance = _build_matrix(df)

    partners: dict[int, list[Partner]] = {}
    for a in range(1, 46):
        count_a = int(appearance[a])
        if count_a == 0:
            partners[a] = []
            continue

        candidates: list[Partner] = []
        support_a = count_a / total_rounds
        for b in range(1, 46):
            if b == a:
                continue
            count_ab = int(co[a][b])
            count_b = int(appearance[b])
            if count_b == 0:
                continue
            support_ab = count_ab / total_rounds
            support_b = count_b / total_rounds
            confidence = count_ab / count_a
            denom = support_a * support_b
            lift = support_ab / denom if denom > 0 else 0.0
            is_sig = lift >= LIFT_SIGNIFICANT_THRESHOLD and count_ab >= COUNT_SIGNIFICANT_MIN
            candidates.append(
                Partner(
                    number=b,
                    count=count_ab,
                    confidence=confidence,
                    lift=lift,
                    is_significant=is_sig,
                )
            )

        # 우선순위: count 내림차순 → lift 내림차순 → 번호 오름차순
        candidates.sort(key=lambda p: (-p.count, -p.lift, p.number))
        partners[a] = candidates[:top_n]

    return CoOccurrenceSummary(
        total_rounds=total_rounds,
        appearance_counts={n: int(appearance[n]) for n in range(1, 46)},
        baseline_confidence=BASELINE_CONFIDENCE,
        top_n=top_n,
        partners=partners,
        disclaimer=DISCLAIMER,
    )
