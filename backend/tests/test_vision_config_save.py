import pytest

from app.video_analysis.vision_config import save_vision_api_key


def test_save_vision_api_key(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("VIDEO_VISION_API_KEY=\n", encoding="utf-8")
    monkeypatch.setattr("app.video_analysis.vision_config.ENV_PATH", env)

    save_vision_api_key("sk-test-key-1234567890")
    text = env.read_text(encoding="utf-8")
    assert "VIDEO_VISION_API_KEY=sk-test-key-1234567890" in text

    with pytest.raises(ValueError):
        save_vision_api_key("invalid")
