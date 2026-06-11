"""Vision API 키 로컬 저장 (backend/.env)."""
from __future__ import annotations

import re
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = _BACKEND_DIR / ".env"


def _read_lines() -> list[str]:
    if not ENV_PATH.exists():
        return [
            "# 유튜브 영상 Vision 분석 (OpenAI API 키)",
            "VIDEO_VISION_API_KEY=",
            "VIDEO_VISION_MODEL=gpt-4o-mini",
            "VIDEO_ANALYSIS_MAX_FRAMES=36",
            "",
        ]
    return ENV_PATH.read_text(encoding="utf-8").splitlines()


def save_vision_api_key(api_key: str, model: str = "gpt-4o-mini") -> None:
    key = api_key.strip()
    if not key:
        raise ValueError("API 키가 비어 있습니다.")
    if not key.startswith("sk-"):
        raise ValueError("OpenAI API 키 형식이 아닙니다. (sk- 로 시작)")

    lines = _read_lines()
    out: list[str] = []
    seen_key = False
    seen_model = False

    for line in lines:
        if re.match(r"^\s*VIDEO_VISION_API_KEY\s*=", line):
            out.append(f"VIDEO_VISION_API_KEY={key}")
            seen_key = True
            continue
        if re.match(r"^\s*OPENAI_API_KEY\s*=", line):
            continue
        if re.match(r"^\s*VIDEO_VISION_MODEL\s*=", line):
            out.append(f"VIDEO_VISION_MODEL={model}")
            seen_model = True
            continue
        out.append(line)

    if not seen_key:
        out.append(f"VIDEO_VISION_API_KEY={key}")
    if not seen_model:
        out.append(f"VIDEO_VISION_MODEL={model}")

    ENV_PATH.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

    # 실행 중 settings 갱신
    from app.config import settings

    settings.VIDEO_VISION_API_KEY = key
    settings.VIDEO_VISION_MODEL = model


def clear_vision_api_key() -> None:
    lines = _read_lines()
    out: list[str] = []
    for line in lines:
        if re.match(r"^\s*VIDEO_VISION_API_KEY\s*=", line):
            out.append("VIDEO_VISION_API_KEY=")
            continue
        out.append(line)
    ENV_PATH.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

    from app.config import settings

    settings.VIDEO_VISION_API_KEY = ""


def set_photo_use_vision(enabled: bool) -> None:
    lines = _read_lines()
    out: list[str] = []
    seen = False
    value = "true" if enabled else "false"
    for line in lines:
        if re.match(r"^\s*PHOTO_USE_VISION_API\s*=", line):
            out.append(f"PHOTO_USE_VISION_API={value}")
            seen = True
            continue
        out.append(line)
    if not seen:
        out.append(f"PHOTO_USE_VISION_API={value}")
    ENV_PATH.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

    from app.config import settings

    settings.PHOTO_USE_VISION_API = enabled
