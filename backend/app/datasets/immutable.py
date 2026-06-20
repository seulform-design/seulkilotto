"""불변 데이터 유틸 — Historical 소스 오염 방지."""
from __future__ import annotations

import copy
from typing import Any, Mapping, Sequence

import pandas as pd


def freeze_mapping(data: Mapping[str, Any]) -> dict[str, Any]:
    """깊은 복사로 읽기 전용 스냅숏 생성."""
    return copy.deepcopy(dict(data))


def freeze_sequence(items: Sequence[Any]) -> list[Any]:
    return copy.deepcopy(list(items))


def freeze_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """DataFrame 깊은 복사 — 규칙 엔진 내부 변형이 소스를 오염시키지 않도록."""
    return df.copy(deep=True)


def assert_not_mutating_source(before: pd.DataFrame, after: pd.DataFrame, *, label: str = "historical") -> None:
    """소스 DataFrame이 연산 중 변형되었으면 즉시 예외."""
    if before.shape != after.shape:
        raise RuntimeError(f"{label} dataset shape mutated during computation")
    if not before.equals(after):
        raise RuntimeError(f"{label} dataset content mutated during computation — leakage guard")
