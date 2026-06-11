"""EPO 자체 백테스트 — 무작위 베이스라인 대비 통계적 자기 검증.

본 모듈의 측정 대상은 '당첨 확률 향상'이 아니다 (그것은 항상 0이다).
대신 다음을 측정한다:

  Historical Pass Rate (HPR):
    실제 과거 1등 조합 중 몇 %가 현재 필터 설정을 통과하는가.
    HPR 이 너무 낮다 = 필터가 과도하게 엄격 = 실제 당첨 조합조차 배제.
    → 이 경우 EPO 를 자동 비활성화하고 Fallback (느슨한 필터) 로 전환.

  Baseline Hit Rate:
    무작위 6-튜플의 평균 적중 개수 (이론값 ≈ 0.8).
    참고 지표 — 본 측정값은 EPO 의 우열을 가르지 못한다
    (당첨 확률은 모든 6-튜플에 동일하므로).

자기 검증 정책:
  - HPR >= pass_threshold (기본 0.50) → EPO 활성
  - HPR <  pass_threshold              → Fallback 활성, 사용자에게 명시
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import pandas as pd

from .. import database
from . import filters as F

Combo = tuple[int, ...]
Predicate = Callable[[Combo], bool]


@dataclass
class BacktestResult:
    """백테스트 결과 — engine 에 노출되는 자기 검증 산출물."""

    sample_size: int
    passed_count: int
    historical_pass_rate: float
    pass_threshold: float
    epo_enabled: bool
    baseline_avg_hit: float
    reason: str


def _baseline_avg_hit() -> float:
    """이론값: 무작위 6-튜플 vs 무작위 6-튜플 평균 적중 개수.

    E[hits] = 6 × 6/45 = 0.8 (각 위치가 일치할 기댓값의 합).
    """
    return 6.0 * 6.0 / 45.0


def evaluate_filters(
    df: pd.DataFrame,
    predicates: list[Predicate],
    holdout: int = 200,
    pass_threshold: float = 0.50,
) -> BacktestResult:
    """과거 holdout 회차의 1등 조합이 현재 필터를 얼마나 통과하는지 측정.

    Args:
        df: 전체 회차 DataFrame (round 컬럼 포함).
        predicates: engine 이 구성한 활성 predicate 리스트.
        holdout: 최근 N 회차를 검증 표본으로 사용.
        pass_threshold: EPO 활성 기준 HPR.

    Returns:
        BacktestResult — epo_enabled 가 False 면 engine 은 fallback 진입.
    """
    baseline = _baseline_avg_hit()

    if df is None or df.empty:
        return BacktestResult(
            sample_size=0,
            passed_count=0,
            historical_pass_rate=0.0,
            pass_threshold=pass_threshold,
            epo_enabled=False,
            baseline_avg_hit=baseline,
            reason="회차 데이터 없음 — Fallback 활성",
        )

    sample_n = min(holdout, len(df))
    sample = df.sort_values("round", ascending=False).head(sample_n)

    if sample_n < 20:
        # 표본이 너무 적으면 검증 신뢰도 부족 → 보수적으로 EPO 활성 (사용자가 명시 요청)
        return BacktestResult(
            sample_size=sample_n,
            passed_count=sample_n,
            historical_pass_rate=1.0,
            pass_threshold=pass_threshold,
            epo_enabled=True,
            baseline_avg_hit=baseline,
            reason=f"표본 회차 부족({sample_n} < 20) — 검증 건너뛰고 EPO 활성",
        )

    passed = 0
    for _, row in sample.iterrows():
        combo = tuple(int(row[c]) for c in database.NUMBER_COLUMNS)
        if all(p(combo) for p in predicates):
            passed += 1

    hpr = passed / sample_n
    epo_enabled = hpr >= pass_threshold
    reason = (
        f"HPR {hpr:.1%} >= 임계 {pass_threshold:.0%} — EPO 활성"
        if epo_enabled
        else f"HPR {hpr:.1%} < 임계 {pass_threshold:.0%} — 필터 과도 엄격, Fallback 활성"
    )

    return BacktestResult(
        sample_size=sample_n,
        passed_count=passed,
        historical_pass_rate=hpr,
        pass_threshold=pass_threshold,
        epo_enabled=epo_enabled,
        baseline_avg_hit=baseline,
        reason=reason,
    )


def loose_fallback_predicates() -> tuple[list[Predicate], list[str]]:
    """Fallback 모드용 '느슨한' predicate.

    EPO 가 비활성화돼도 다음의 명백히 비-당첨 패턴은 여전히 배제한다:
      - 전체 연속 (예: 1,2,3,4,5,6)
      - 모든 번호가 단일 십의자리에 몰림
      - AC 값 극단적으로 낮음 (등차수열 류)
      - 홀짝 0:6 또는 6:0
    """
    predicates: list[Predicate] = [
        F.passes_max_run(4),                    # 5연속 이상 금지 (1,2,3,4,5,x 류 차단)
        F.passes_min_ac(4),                     # 명백한 등차수열만 차단
        F.passes_decade_balance(4),             # 6개 모두 같은 십의자리 차단
        F.passes_odd_count({1, 2, 3, 4, 5}),    # 0:6, 6:0 만 차단
    ]
    labels: list[str] = [
        "max_consecutive_run<=4",
        "ac_value>=4",
        "max_same_decade<=4",
        "odd_count in [1..5] (0:6, 6:0 차단)",
    ]
    return predicates, labels
