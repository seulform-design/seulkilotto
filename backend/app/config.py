"""애플리케이션 환경 설정.

.env 파일 또는 환경변수에서 DB 접속 정보 등을 읽어온다.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # PostgreSQL 접속 URL. 예) postgresql+psycopg2://user:pass@localhost:5432/lotto
    DATABASE_URL: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/lotto"

    # 미출현 번호 가중치 (요구사항: 최근 5주 미출현 번호에 +15%)
    UNSEEN_WEIGHT_BONUS: float = 0.15
    UNSEEN_LOOKBACK_DRAWS: int = 5

    # 현재 로또 회차 하한. 실제 값은 max(최신회차+1, CURRENT_ROUND) 로 자동 계산.
    CURRENT_ROUND: int = 1227

    # load_history() 캐시 TTL(초). CSV mtime 변경 시 즉시 무효화.
    HISTORY_CACHE_TTL: int = 300

    # 운영 CORS 허용 도메인 (쉼표 구분). 비어 있으면 개발용 전체 허용.
    CORS_ORIGINS: str = ""

    # 회차 업그레이드
    CRAWL_SOURCE: str = "lottis"  # auto | dhlottery | lottis
    CRAWL_DELAY_SEC: float = 0.35
    SCHEDULER_ENABLED: bool = False  # True 시 매주 토 22:30 자동 크롤
    UPGRADE_API_KEY: str = ""  # 설정 시 POST /data/upgrade 에 X-Upgrade-Key 필요

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
