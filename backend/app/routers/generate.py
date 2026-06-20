"""번호 생성 엔드포인트 (/api/v1/generate).

[기획서 API 3] GET /api/v1/generate/weights
- 최근 lookback(기본 5회) 미출현 번호에 settings.UNSEEN_WEIGHT_BONUS(+15%) 가산
- np.random.choice 비복원 추출로 6개 번호 1조합 생성 (n_sets 로 여러 게임 가능)

[EPO] GET /api/v1/generate/epo
- Multi-Stage Filter Pipeline (sum/AC/odd-even/high-low/decade/run/overlap)
- 자기 검증(backtest) → 통과 시 EPO 활성, 불통 시 Fallback
- 모든 응답에 honesty 메타 강제 포함
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query

from .. import analytics
from .. import epo as epo_module
from ..config import settings
from ..data_meta import effective_current_round
from ..database import load_history
from ..datasets.historical import get_historical_dataset
from ..pipeline.rule_engine import build_rule_engine_for_current
from ..schemas import EpoResponse, GenerateResponse
from ..video_analysis.store import record_current_rule_engine_output

router = APIRouter(prefix="/api/v1/generate", tags=["generate"])


@router.get("/weights", response_model=GenerateResponse)
def generate_weighted(
    n_sets: int = Query(default=1, ge=1, le=20, description="생성할 추천 조합 수 (기본 1조합)"),
    lookback: int = Query(
        default=settings.UNSEEN_LOOKBACK_DRAWS,
        ge=1,
        description="미출현 번호를 판단할 최근 회차 수 (기본 5주)",
    ),
    exclude_consecutive: bool = Query(
        default=False, description="연속 번호가 포함된 조합 제외 여부"
    ),
    seed: int | None = Query(default=None, description="재현용 랜덤 시드(선택)"),
    scope: str = Query(
        default="ephemeral",
        description="ephemeral=일회성 응답 | current=이번회차 샌드박스 독립 생산·저장",
    ),
):
    """최근 N주 미출현 번호에 +15% 가중치를 부여한 통계 기반 추천 조합을 생성한다."""
    if scope == "current":
        engine = build_rule_engine_for_current(
            "weighted",
            params={"unseen_bonus": settings.UNSEEN_WEIGHT_BONUS, "lookback": lookback},
        )
        hist = get_historical_dataset()
        if hist.get_completed_rounds_only().empty:
            raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
        wrapped = engine.produce_and_persist_weighted(
            n_sets=n_sets,
            lookback=lookback,
            exclude_consecutive=exclude_consecutive,
            seed=seed,
            historical=hist,
        )
        return GenerateResponse.model_validate(wrapped["result"])

    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    payload = analytics.generate_weighted_sets(
        df,
        n_sets=n_sets,
        unseen_bonus=settings.UNSEEN_WEIGHT_BONUS,  # 0.15 (=15%)
        lookback=lookback,
        exclude_consecutive=exclude_consecutive,
        seed=seed,
    )
    latest_round = int(df["round"].max())
    record_current_rule_engine_output(
        "weighted_generation",
        round_no=effective_current_round(latest_round),
        latest_round=latest_round,
        payload=payload,
        rule_snapshot={
            "n_sets": n_sets,
            "lookback": lookback,
            "exclude_consecutive": exclude_consecutive,
            "seed": seed,
            "unseen_bonus": settings.UNSEEN_WEIGHT_BONUS,
        },
    )
    return payload


@router.get("/smart", response_model=GenerateResponse)
def generate_smart(
    n_sets: int = Query(default=5, ge=1, le=10),
    lookback: int = Query(default=5, ge=1),
    exclude_consecutive: bool = Query(default=True),
    max_overlap: int = Query(default=2, ge=0, le=4, description="게임 간 최대 겹치는 번호 수"),
    seed: int | None = Query(default=None),
    scope: str = Query(default="ephemeral", description="ephemeral | current (샌드박스 저장)"),
):
    """다양화·역사적 필터·희귀도 기반 스마트 조합 (당첨 확률 보장 아님)."""
    if scope == "current":
        engine = build_rule_engine_for_current("smart", params={"lookback": lookback})
        hist = get_historical_dataset()
        if hist.get_completed_rounds_only().empty:
            raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
        wrapped = engine.produce_and_persist_smart(
            n_sets=n_sets,
            lookback=lookback,
            exclude_consecutive=exclude_consecutive,
            max_overlap=max_overlap,
            seed=seed,
            historical=hist,
        )
        return GenerateResponse.model_validate(wrapped["result"])

    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    payload = analytics.generate_smart_sets(
        df,
        n_sets=n_sets,
        lookback=lookback,
        exclude_consecutive=exclude_consecutive,
        max_overlap=max_overlap,
        seed=seed,
    )
    latest_round = int(df["round"].max())
    record_current_rule_engine_output(
        "smart_generation",
        round_no=effective_current_round(latest_round),
        latest_round=latest_round,
        payload=payload,
        rule_snapshot={
            "n_sets": n_sets,
            "lookback": lookback,
            "exclude_consecutive": exclude_consecutive,
            "max_overlap": max_overlap,
            "seed": seed,
        },
    )
    return payload


@router.get("/epo", response_model=EpoResponse)
def generate_epo(
    n_sets: int = Query(default=5, ge=1, le=20, description="생성할 조합 수"),
    lookback: int = Query(default=10, ge=1, le=200, description="핫/콜드 산정 윈도우"),
    hot_bonus: float = Query(default=0.0, ge=0.0, le=0.5, description="핫 넘버 가중치 가산"),
    cold_bonus: float = Query(default=0.15, ge=0.0, le=0.5, description="콜드 넘버 가중치 가산"),
    sum_min: int | None = Query(default=None, ge=21, le=255),
    sum_max: int | None = Query(default=None, ge=21, le=255),
    max_consecutive_run: int = Query(default=2, ge=1, le=6),
    min_ac_value: int = Query(default=7, ge=0, le=10),
    max_same_decade: int = Query(default=3, ge=1, le=6),
    min_last_digit_unique: int = Query(default=3, ge=1, le=10),
    max_last_round_overlap: int = Query(default=1, ge=0, le=6),
    inter_set_max_overlap: int = Query(default=3, ge=0, le=6),
    enable_backtest: bool = Query(default=True),
    backtest_holdout: int = Query(default=200, ge=20, le=2000),
    backtest_threshold: float = Query(default=0.50, ge=0.0, le=1.0),
    seed: int | None = Query(default=None),
):
    """EPO (Expected Payout Optimization) 엔진.

    수학적 정직 선언:
      - 당첨 확률은 1/8,145,060 — 본 엔드포인트도 동일합니다.
      - 본 엔진은 '경험적 분포에 정렬된 조합' + '인기 픽 회피' 가 목표입니다.
      - 자기 검증(backtest) 이 실패하면 자동으로 Fallback 모드로 전환됩니다.
    """
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")

    config = epo_module.EpoConfig(
        n_sets=n_sets,
        lookback=lookback,
        hot_bonus=hot_bonus,
        cold_bonus=cold_bonus,
        sum_min=sum_min,
        sum_max=sum_max,
        max_consecutive_run=max_consecutive_run,
        min_ac_value=min_ac_value,
        max_same_decade=max_same_decade,
        min_last_digit_unique=min_last_digit_unique,
        max_last_round_overlap=max_last_round_overlap,
        inter_set_max_overlap=inter_set_max_overlap,
        enable_backtest=enable_backtest,
        backtest_holdout=backtest_holdout,
        backtest_threshold=backtest_threshold,
        seed=seed,
    )

    result = epo_module.run(df, config)

    profile = asdict(result.profile)
    profile["last_round_combo"] = list(profile.get("last_round_combo") or [])

    response = EpoResponse(
        engine=result.engine,
        combinations=result.combinations,
        profile=profile,
        weights=result.weights_meta,
        pipeline=result.pipeline_meta,
        backtest=result.backtest_meta,
        honesty=result.honesty,
    )
    latest_round = int(df["round"].max())
    record_current_rule_engine_output(
        "epo_generation",
        round_no=effective_current_round(latest_round),
        latest_round=latest_round,
        payload=response.model_dump(mode="json"),
        rule_snapshot={
            "n_sets": n_sets,
            "lookback": lookback,
            "hot_bonus": hot_bonus,
            "cold_bonus": cold_bonus,
            "sum_min": sum_min,
            "sum_max": sum_max,
            "max_consecutive_run": max_consecutive_run,
            "min_ac_value": min_ac_value,
            "max_same_decade": max_same_decade,
            "min_last_digit_unique": min_last_digit_unique,
            "max_last_round_overlap": max_last_round_overlap,
            "inter_set_max_overlap": inter_set_max_overlap,
            "enable_backtest": enable_backtest,
            "backtest_holdout": backtest_holdout,
            "backtest_threshold": backtest_threshold,
            "seed": seed,
        },
    )
    return response
