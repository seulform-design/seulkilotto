"""FastAPI 통합 테스트 (SQLite)."""
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200


def test_data_status(client):
    r = client.get("/api/data/status")
    assert r.status_code == 200
    assert "ok" in r.json()


def test_triple_matrix_top(client):
    r = client.get("/api/triple-matrix?mode=top&limit=10")
    if r.status_code == 200:
        assert "items" in r.json()


def test_rules_endpoint(client):
    # simple: pair→next (빠름). fpgrowth는 수동/프론트에서 실행
    r = client.get("/api/rules?method=simple&min_support=0.02")
    assert r.status_code == 200
    assert "rules" in r.json()
