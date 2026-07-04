"""Pydantic 응답/요청 스키마 정의 (API 입출력 계약)."""
from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field, field_validator


# --- /stats/frequency ---------------------------------------------------------
class FrequencyItem(BaseModel):
    number: int = Field(..., ge=1, le=45, description="로또 번호 1~45")
    count: int = Field(..., description="해당 번호 출현 횟수")
    ratio: float = Field(..., description="전체 추첨 대비 출현 비율(0~1)")


class FrequencyResponse(BaseModel):
    total_rounds: int = Field(..., description="집계에 사용된 회차 수")
    items: List[FrequencyItem]


# --- /stats/temperature ------------------------------------------------------
class TemperatureItem(BaseModel):
    number: int = Field(..., ge=1, le=45)
    recent_count: int = Field(..., description="lookback 윈도우 내 출현 횟수")
    gap: int = Field(..., description="마지막 출현 이후 경과 회차")
    total_count: int = Field(..., description="전체 회차 누적 출현 횟수")
    score: float = Field(..., description="합성 온도 점수 [-1, +1]")
    tier: str = Field(..., description="hot | warm | neutral | cold | frozen")
    rank: int = Field(..., description="1 = 가장 hot, 45 = 가장 frozen")


class TemperatureResponse(BaseModel):
    lookback: int
    latest_round: int
    total_rounds: int
    items: List[TemperatureItem]
    tier_distribution: dict = Field(..., description="등급별 번호 수 (각 9개)")
    tier_labels: dict = Field(..., description="등급 → 한글/이모지 라벨")
    tier_colors: dict = Field(..., description="등급 → 색상 HEX")
    disclaimer: str


# --- /stats/co-occurrence -----------------------------------------------------
class CoOccurrencePartner(BaseModel):
    number: int = Field(..., ge=1, le=45)
    count: int = Field(..., description="함께 등장한 회차 수")
    confidence: float = Field(..., description="P(이 번호 | source 출현)")
    lift: float = Field(..., description="actual / expected (1.0 = 무작위)")
    is_significant: bool = Field(..., description="lift>=1.2 AND count>=30")


class CoOccurrenceResponse(BaseModel):
    total_rounds: int
    appearance_counts: dict = Field(..., description="번호 → 전체 출현 회차 수")
    baseline_confidence: float = Field(..., description="무작위 베이스라인 ≈ 5/44 ≈ 11.4%")
    top_n: int = Field(..., description="각 번호의 상위 N개 동반 번호 노출")
    partners: dict = Field(..., description="번호 → [Partner...] 상위 N개")
    disclaimer: str


# --- /stats/walk-forward ------------------------------------------------------
class WalkForwardStrategyResult(BaseModel):
    strategy: str
    rounds_tested: int
    sets_generated: int
    avg_hits_per_set: float
    hit_distribution: dict = Field(..., description="hits(0~6) → 발생 횟수")
    cumulative_avg: List[float] = Field(..., description="회차별 누적 평균 적중")
    rounds_axis: List[int]
    hit_rate_3plus: float
    hit_rate_4plus: float
    hit_rate_5plus: float
    hit_rate_6: float
    delta_vs_baseline: float = 0.0
    z_score: float = 0.0
    beats_baseline: bool = False


class WalkForwardResponse(BaseModel):
    start_round: int
    end_round: int
    rounds_evaluated: int
    sets_per_round: int
    baseline_avg_hits: float
    strategies: List[WalkForwardStrategyResult]
    disclaimer: str


# --- /analyze/combination -----------------------------------------------------
class CombinationRequest(BaseModel):
    numbers: List[int] = Field(..., min_length=6, max_length=6, description="분석할 6개 번호")

    @field_validator("numbers")
    @classmethod
    def validate_numbers(cls, v: List[int]) -> List[int]:
        if any(n < 1 or n > 45 for n in v):
            raise ValueError("모든 번호는 1~45 사이여야 합니다.")
        if len(set(v)) != 6:
            raise ValueError("중복되지 않는 6개의 번호를 입력해야 합니다.")
        return sorted(v)


class CombinationAnalysis(BaseModel):
    numbers: List[int]
    odd_count: int = Field(..., description="홀수 개수")
    even_count: int = Field(..., description="짝수 개수")
    sum_total: int = Field(..., description="6개 번호 총합")
    sum_band: str = Field(..., description="총합 구간 (낮음/보통/높음)")
    has_consecutive: bool = Field(..., description="연속 번호 존재 여부")
    consecutive_pairs: List[List[int]] = Field(..., description="연속 번호 쌍 목록")


# --- /generate/weights --------------------------------------------------------
class GeneratedCombination(BaseModel):
    numbers: List[int]
    sum_total: int
    odd_count: int
    even_count: int
    rarity_score: float | None = Field(default=None, description="희귀도 점수(높을수록 흔한 패턴 회피)")


class GenerateResponse(BaseModel):
    unseen_numbers: List[int] = Field(..., description="최근 N회 미출현 번호(가중치 부여 대상)")
    combinations: List[GeneratedCombination]
    warning: str | None = Field(default=None, description="요청 조합 수 미달 등 경고")
    strategy: str | None = None
    disclaimer: str | None = None


# --- /generate/epo ------------------------------------------------------------
class EpoHonestyMeta(BaseModel):
    """확률적 정직성 메타. 모든 EPO 응답에 강제 포함."""

    win_probability_per_set: float = Field(..., description="6-튜플 1세트의 1등 당첨 확률 (=1/8,145,060)")
    win_probability_unchanged: bool = Field(True, description="EPO 적용 후에도 당첨 확률 불변임을 명시")
    optimization_target: str = Field(..., description="EPO 가 실제로 최적화하는 변수")
    disclaimer: str = Field(..., description="사용자에게 노출되는 면책 문구")


class EpoCombination(BaseModel):
    """EPO 가 산출한 단일 조합 + 모든 통계 메트릭."""

    numbers: List[int] = Field(..., min_length=6, max_length=6)
    sum_total: int
    odd_count: int
    even_count: int
    high_count: int = Field(..., description="23 이상 번호 개수")
    low_count: int = Field(..., description="22 이하 번호 개수")
    ac_value: int = Field(..., description="Arithmetic Complexity (구조적 조합 회피 지수)")
    max_consecutive_run: int = Field(..., description="연속 번호 최대 길이")
    max_same_decade: int = Field(..., description="동일 십의자리 그룹 최대 몰림")
    last_digit_unique: int = Field(..., description="끝자리 종류 수")
    decade_distribution: dict = Field(..., description="십의자리별 개수 분포")
    last_round_overlap: int = Field(..., description="직전 회차 조합과의 공통 번호 수")


class EpoHistoricalProfile(BaseModel):
    """과거 1등 조합에서 추출한 경험적 분포."""

    rounds_analyzed: int
    sum_p01: int
    sum_p10: int
    sum_p50: int
    sum_p90: int
    sum_p99: int
    sum_mean: float
    odd_count_freq: dict
    high_count_freq: dict
    odd_count_modes: List[int]
    high_count_modes: List[int]
    avg_ac: float
    p10_ac: int
    max_run_p95: int
    last_round_no: int | None = None
    last_round_combo: List[int] = Field(default_factory=list)


class EpoBacktestMeta(BaseModel):
    """자기 검증 결과 — fallback 활성 여부를 결정한 근거."""

    epo_enabled: bool
    fallback_active: bool
    historical_pass_rate: float
    pass_threshold: float
    sample_size: int
    passed_count: int
    baseline_avg_hit_count: float = Field(..., description="무작위 베이스라인 평균 적중 개수(이론값)")
    reason: str
    filters_validated: List[str]
    p_value_validation: bool


class EpoWeightsMeta(BaseModel):
    lookback_rounds: int
    hot_bonus: float
    cold_bonus: float
    hot_numbers: List[int]
    cold_numbers: List[int]
    weight_uniform: bool


class EpoPipelineMeta(BaseModel):
    active_mode: str = Field(..., description="'epo' 또는 'fallback'")
    candidates_attempted: int
    combinations_returned: int
    combinations_requested: int
    max_attempts_cap: int
    filters_applied: List[str]
    sum_range_applied: List[int] | None = None
    diversity_max_overlap: int
    shortfall_warning: str | None = None


class EpoResponse(BaseModel):
    """EPO 엔진 최종 응답. 모든 메트릭 + honesty 메타 강제 포함."""

    engine: str = Field(..., description="엔진 식별자")
    combinations: List[EpoCombination]
    profile: EpoHistoricalProfile
    weights: EpoWeightsMeta
    pipeline: EpoPipelineMeta
    backtest: EpoBacktestMeta
    honesty: EpoHonestyMeta
