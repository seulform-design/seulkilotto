"""플랫폼 환경 설정."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # 로컬: SQLite (Docker 없이 즉시 실행). 운영: PostgreSQL URL 로 교체.
    DATABASE_URL: str = "sqlite:///./lotto_research.db"
    REDIS_URL: str = "redis://127.0.0.1:6379/0"
    CACHE_TTL_SEC: int = 300
    GLOBAL_SEED: int = 42
    MONTE_CARLO_DEFAULT: int = 100_000
    BACKTEST_TRAIN_MIN: int = 100
    BACKTEST_STEP: int = 1
    SCHEDULER_ENABLED: bool = False  # 테스트 시 False; 운영 시 True

    # Admin API 키. 설정 시 /api/admin/* 요청에 X-Admin-Key 헤더 필요.
    ADMIN_API_KEY: str = ""

    # 운영 CORS (쉼표 구분). 비어 있으면 개발용 전체 허용.
    CORS_ORIGINS: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
