"""애플리케이션 환경 설정.

.env 파일 또는 환경변수에서 DB 접속 정보 등을 읽어온다.
"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_ENV_CANDIDATES = [_BACKEND_DIR / ".env", _BACKEND_DIR.parent / ".env"]


class Settings(BaseSettings):
    # PostgreSQL 접속 URL. 예) postgresql+psycopg2://user:pass@localhost:5432/lotto
    DATABASE_URL: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/lotto"

    # 미출현 번호 가중치 (요구사항: 최근 5주 미출현 번호에 +15%)
    UNSEEN_WEIGHT_BONUS: float = 0.15
    UNSEEN_LOOKBACK_DRAWS: int = 5

    # 현재 로또 회차 하한. 실제 값은 max(최신회차+1, CURRENT_ROUND) 로 자동 계산.
    # ※ CSV에 최신 회차가 있으면 해당 값+1이 우선 적용됨.
    #    하드코딩 없이 CSV 기반으로 동작하도록 최솟값(1)으로 설정.
    CURRENT_ROUND: int = 1

    # load_history() 캐시 TTL(초). CSV mtime 변경 시 즉시 무효화.
    HISTORY_CACHE_TTL: int = 300

    # 운영 CORS 허용 도메인 (쉼표 구분). 비어 있으면 개발용 전체 허용.
    CORS_ORIGINS: str = ""

    # 회차 업그레이드
    CRAWL_SOURCE: str = "lottis"  # auto | dhlottery | lottis
    CRAWL_DELAY_SEC: float = 0.35
    SCHEDULER_ENABLED: bool = True   # 매주 토 22:35 KST 자동 크롤 (False 로 비활성화 가능)
    UPGRADE_API_KEY: str = ""  # 설정 시 POST /data/upgrade 에 X-Upgrade-Key 필요

    # 용지 사진 Vision 분석 (선택 — False 이면 OpenCV 로컬 분석만 사용)
    PHOTO_USE_VISION_API: bool = False
    VIDEO_VISION_API_KEY: str = ""  # OPENAI_API_KEY 와 동일 키 사용 가능
    VIDEO_VISION_MODEL: str = "gpt-4o-mini"
    VIDEO_ANALYSIS_MAX_FRAMES: int = 36
    PHOTO_ANALYSIS_MAX_IMAGES: int = 50

    model_config = SettingsConfigDict(
        env_file=tuple(str(p) for p in _ENV_CANDIDATES if p.exists()) or ".env",
        env_file_encoding="utf-8",
    )


settings = Settings()
