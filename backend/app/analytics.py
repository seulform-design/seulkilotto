"""핵심 통계/분석 알고리즘 (Pandas + NumPy).

모든 함수는 순수 함수(side-effect 없음)로 설계되어 단위 테스트가 용이하다.
입력은 database.load_history() 가 만든 표준 DataFrame 을 사용한다.
"""
from __future__ import annotations

import random
from typing import Dict, List

import numpy as np
import pandas as pd

from .database import NUMBER_COLUMNS

ALL_NUMBERS = list(range(1, 46))  # 로또 전체 번호 풀


# =============================================================================
# 1) 번호별 출현 빈도 분석
# =============================================================================
def calc_frequency(df: pd.DataFrame, recent_n: int | None = None) -> Dict:
    """1~45번 번호별 출현 빈도수 및 비율을 계산한다.

    Args:
        df: 전체 회차 DataFrame (round 오름차순).
        recent_n: 최근 N회차만 집계. None 이면 전체.

    Returns:
        {"total_rounds": int, "items": [{number, count, ratio}, ...]}
    """
    # 최근 N회차 슬라이싱 (round 기준 내림차순 상위 N개)
    target = df.sort_values("round", ascending=False).head(recent_n) if recent_n else df
    total_rounds = len(target)

    # 6개 번호 컬럼을 1차원으로 펼친 뒤 value_counts 로 빈도 집계 (벡터 연산)
    flat = target[NUMBER_COLUMNS].to_numpy().ravel()
    counts = pd.Series(flat).value_counts()

    items: List[Dict] = []
    for n in ALL_NUMBERS:
        c = int(counts.get(n, 0))
        # 비율 = 해당 번호 출현 수 / 전체 추첨 회차 수 (한 회차당 한 번 출현 가능 기준)
        ratio = round(c / total_rounds, 4) if total_rounds else 0.0
        items.append({"number": n, "count": c, "ratio": ratio})

    # 빈도 내림차순 정렬하여 "핫 넘버"가 상단에 오도록 함
    items.sort(key=lambda x: x["count"], reverse=True)
    return {"total_rounds": total_rounds, "items": items}


# =============================================================================
# 2) 사용자 조합 분석 (홀짝/총합/연속번호)
# =============================================================================
def analyze_combination(numbers: List[int]) -> Dict:
    """6개 번호 조합의 홀짝 비율, 총합 구간, 연속 번호 여부를 분석한다."""
    nums = sorted(numbers)

    odd_count = sum(1 for n in nums if n % 2 == 1)
    even_count = len(nums) - odd_count
    sum_total = int(sum(nums))

    # 총합 구간 분류: 6개 번호 합의 통계적 중앙(약 100~170)을 기준으로 구간화
    if sum_total < 100:
        sum_band = "낮음"
    elif sum_total <= 170:
        sum_band = "보통"
    else:
        sum_band = "높음"

    # 연속 번호(예: 11,12) 탐지
    consecutive_pairs: List[List[int]] = []
    for i in range(len(nums) - 1):
        if nums[i + 1] - nums[i] == 1:
            consecutive_pairs.append([nums[i], nums[i + 1]])

    return {
        "numbers": nums,
        "odd_count": odd_count,
        "even_count": even_count,
        "sum_total": sum_total,
        "sum_band": sum_band,
        "has_consecutive": len(consecutive_pairs) > 0,
        "consecutive_pairs": consecutive_pairs,
    }


# =============================================================================
# 3) 가중치 기반 번호 조합 생성
# =============================================================================
def find_unseen_numbers(df: pd.DataFrame, lookback: int = 5) -> List[int]:
    """최근 `lookback` 회차 동안 한 번도 출현하지 않은 번호 목록 반환."""
    recent = df.sort_values("round", ascending=False).head(lookback)
    seen = set(recent[NUMBER_COLUMNS].to_numpy().ravel().tolist())
    return [n for n in ALL_NUMBERS if n not in seen]


def build_weights(
    df: pd.DataFrame,
    unseen_bonus: float = 0.15,
    lookback: int = 5,
) -> np.ndarray:
    """각 번호(1~45)의 선택 가중치 배열을 생성한다.

    가중치 = (전체 기간 출현 빈도 기반 base 확률)
             × (미출현 번호면 1 + unseen_bonus)

    - base: 자주 나온 번호일수록 약간 높은 기본 가중치(빈도 기반).
    - 미출현 보너스: 요구사항대로 최근 N회 미출현 번호에 +15% 가산.
    """
    flat = df[NUMBER_COLUMNS].to_numpy().ravel()
    counts = pd.Series(flat).value_counts()

    # 1~45 순서의 기본 빈도 벡터 (0 방지를 위해 +1 라플라스 스무딩)
    base = np.array([counts.get(n, 0) + 1 for n in ALL_NUMBERS], dtype=float)
    base = base / base.sum()

    unseen = set(find_unseen_numbers(df, lookback))
    multiplier = np.array(
        [(1 + unseen_bonus) if n in unseen else 1.0 for n in ALL_NUMBERS],
        dtype=float,
    )

    weights = base * multiplier
    return weights / weights.sum()  # 정규화하여 확률분포로 변환


def generate_weighted_sets(
    df: pd.DataFrame,
    n_sets: int = 6,
    unseen_bonus: float = 0.15,
    lookback: int = 5,
    exclude_consecutive: bool = False,
    seed: int | None = None,
) -> Dict:
    """가중치 기반 추천 번호 조합을 n_sets 개 생성한다.

    Args:
        n_sets: 생성할 조합 수.
        exclude_consecutive: True 면 연속 번호가 포함된 조합을 재추첨.
        seed: 재현성을 위한 시드.
    """
    rng = np.random.default_rng(seed)
    weights = build_weights(df, unseen_bonus, lookback)
    unseen = find_unseen_numbers(df, lookback)

    combinations: List[Dict] = []
    attempts = 0
    max_attempts = n_sets * 50  # 무한 루프 방지

    while len(combinations) < n_sets and attempts < max_attempts:
        attempts += 1
        # 가중치 기반 비복원 추출로 6개 번호 선택
        picked = rng.choice(ALL_NUMBERS, size=6, replace=False, p=weights)
        nums = sorted(int(x) for x in picked)

        if exclude_consecutive:
            if any(nums[i + 1] - nums[i] == 1 for i in range(5)):
                continue  # 연속 번호 포함 시 폐기 후 재추첨

        combinations.append(
            {
                "numbers": nums,
                "sum_total": int(sum(nums)),
                "odd_count": sum(1 for n in nums if n % 2 == 1),
                "even_count": sum(1 for n in nums if n % 2 == 0),
            }
        )

    result: Dict = {"unseen_numbers": unseen, "combinations": combinations}
    if len(combinations) < n_sets:
        result["warning"] = (
            f"요청 {n_sets}조합 중 {len(combinations)}조합만 생성됐습니다. "
            f"연속번호 제외 등 조건을 완화해 보세요."
        )
    return result
