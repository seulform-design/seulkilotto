"""테스트 DB — 기존 lotto_research.db 또는 CSV 폴백 사용."""
import pytest

from app.db.base import Base
from app.db.session import engine


@pytest.fixture(scope="session", autouse=True)
def prepare_database():
    Base.metadata.create_all(bind=engine)
    yield
