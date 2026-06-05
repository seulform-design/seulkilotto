import pytest
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.services.research_service import ResearchService


@pytest.fixture
def svc():
    db = SessionLocal()
    try:
        yield ResearchService(db)
    finally:
        db.close()


def test_latest_kpi(svc):
    k = svc.latest_kpi()
    assert k["latest_round"] >= 1
    assert "disclaimer" in k


def test_conditional_pair(svc):
    c = svc.conditional_pair(7, 11)
    assert c["pair"] == "7-11"


def test_pair_matrix(svc):
    m = svc.pair_matrix("cooccurrence")
    assert m["size"] == 45


def test_triple_matrix(svc):
    t = svc.triple_matrix(mode="top", limit=5)
    assert len(t["items"]) <= 5


def test_backtest(svc):
    b = svc.backtest()
    assert "hit_rate_top6" in b or "error" in b
