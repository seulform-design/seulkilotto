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


class GenerateResponse(BaseModel):
    unseen_numbers: List[int] = Field(..., description="최근 N회 미출현 번호(가중치 부여 대상)")
    combinations: List[GeneratedCombination]
    warning: str | None = Field(default=None, description="요청 조합 수 미달 등 경고")
