"""연구 플랫폼 REST API — OpenAPI 자동 문서 (/docs)."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.services.research_service import ResearchService

router = APIRouter(prefix="/api", tags=["research"])


def svc(db: Session = Depends(get_db)) -> ResearchService:
    return ResearchService(db)


def verify_admin(x_admin_key: str | None = Header(default=None, alias="X-Admin-Key")) -> None:
    key = settings.ADMIN_API_KEY.strip()
    if key and x_admin_key != key:
        raise HTTPException(status_code=403, detail="Admin API key required")


def _wrap(data: dict) -> dict:
    data.setdefault(
        "disclaimer",
        "과거 데이터 기반 통계이며 미래 당첨을 보장하지 않습니다.",
    )
    return data


@router.get("/machine")
def get_machine(s: ResearchService = Depends(svc)):
    return _wrap(s.machine_analysis())


@router.get("/repeat")
def get_repeat(s: ResearchService = Depends(svc)):
    return _wrap(s.repeat_analysis())


@router.get("/neighbor")
def get_neighbor(s: ResearchService = Depends(svc)):
    return _wrap(s.neighbor_analysis())


@router.get("/ac")
def get_ac(s: ResearchService = Depends(svc)):
    return _wrap(s.ac_analysis())


@router.get("/conditional/pair")
def conditional_pair(
    a: int = Query(..., ge=1, le=45),
    b: int = Query(..., ge=1, le=45),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.conditional_pair(a, b))


@router.get("/conditional/triple")
def conditional_triple(
    a: int = Query(..., ge=1, le=45),
    b: int = Query(..., ge=1, le=45),
    c: int = Query(..., ge=1, le=45),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.conditional_triple(a, b, c))


@router.get("/pair/survival")
def pair_survival(
    a: int = Query(..., ge=1, le=45),
    b: int = Query(..., ge=1, le=45),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.pair_survival(a, b))


@router.get("/triple/survival")
def triple_survival(
    a: int = Query(..., ge=1, le=45),
    b: int = Query(..., ge=1, le=45),
    c: int = Query(..., ge=1, le=45),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.triple_survival(a, b, c))


# 주의: 파라미터 라우트(/pair/{number})는 리터럴 라우트(/pair/survival) 보다
# 뒤에 둬야 한다. 앞에 두면 "/pair/survival" 이 {number}="survival" 로 매칭돼
# 422 가 났다(라우트 셰도잉).
@router.get("/pair/{number}")
def get_pair(number: int, s: ResearchService = Depends(svc)):
    if not 1 <= number <= 45:
        raise HTTPException(400, "number 1~45")
    return _wrap(s.pair_detail(number))


@router.get("/survival")
def survival(
    number: Optional[int] = Query(None, ge=1, le=45),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.survival_numbers(number))


@router.get("/rules")
def rules(
    min_support: float = Query(0.02, ge=0, le=1),
    min_confidence: float = Query(0.15, ge=0, le=1),
    method: str = Query("fpgrowth", description="fpgrowth | simple"),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.association_rules(min_support, min_confidence, method))


@router.get("/markov")
def markov(s: ResearchService = Depends(svc)):
    return _wrap(s.markov_transitions())


@router.get("/pattern-score")
def pattern_score(
    pair: Optional[str] = Query(None, description="예: 7-11"),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.pattern_score(pair))


@router.get("/pattern-decay")
def pattern_decay(
    window: int = Query(30, ge=10, le=200),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.pattern_decay(window))


@router.get("/statistics")
def statistics(s: ResearchService = Depends(svc)):
    return _wrap(s.statistical_validation())


@router.get("/backtest")
def backtest(s: ResearchService = Depends(svc)):
    return _wrap(s.backtest())


@router.get("/simulation")
def simulation(
    n: int = Query(100_000, ge=1000, le=100_000),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.monte_carlo(n))


@router.get("/score")
def score(s: ResearchService = Depends(svc)):
    return _wrap(s.score_ranking())


@router.get("/recommend")
def recommend(
    n_sets: int = Query(5, ge=1, le=20),
    seed: Optional[int] = Query(None),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.recommend(n_sets=n_sets, seed=seed))


@router.get("/dashboard/kpi")
def dashboard_kpi(s: ResearchService = Depends(svc)):
    return _wrap(s.latest_kpi())


@router.get("/data/status")
def data_status(s: ResearchService = Depends(svc)):
    return s.data_status()


@router.get("/pair-matrix")
def pair_matrix(
    metric: str = Query(
        "cooccurrence",
        description="cooccurrence | lift | pmi | conditional",
    ),
    s: ResearchService = Depends(svc),
):
    return _wrap(s.pair_matrix(metric))


@router.get("/triple-matrix")
def triple_matrix(
    mode: str = Query("top", description="top | anchor"),
    anchor: Optional[int] = Query(None, ge=1, le=45),
    metric: str = Query("cooccurrence"),
    limit: int = Query(50, ge=10, le=200),
    s: ResearchService = Depends(svc),
):
    if mode == "anchor" and anchor is None:
        raise HTTPException(400, "anchor 모드에는 anchor=1~45 필요")
    return _wrap(s.triple_matrix(mode=mode, anchor=anchor, metric=metric, limit=limit))


@router.post("/admin/rebuild-patterns")
def rebuild_patterns(
    db: Session = Depends(get_db),
    s: ResearchService = Depends(svc),
    _: None = Depends(verify_admin),
):
    n = s.rebuild_pattern_stats(db)
    return {"rebuilt_pairs": n}


@router.post("/admin/sync-csv")
def sync_csv(_: None = Depends(verify_admin)):
    from app.scheduler.jobs import sync_csv_incremental

    return sync_csv_incremental()
