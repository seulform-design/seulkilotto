from app.video_analysis.image_engine import _normalize_vision_error, _should_use_vision, vision_api_configured


def test_vision_disabled_by_default(monkeypatch):
    monkeypatch.setattr("app.video_analysis.image_engine.settings.PHOTO_USE_VISION_API", False)
    monkeypatch.setattr("app.video_analysis.image_engine.settings.VIDEO_VISION_API_KEY", "sk-test")
    assert _should_use_vision() is False
    assert vision_api_configured() is False


def test_quota_error_hidden_from_user():
    exc = RuntimeError(
        "OpenAI Vision API 사용 한도/잔액이 없습니다. "
        "https://platform.openai.com/account/billing 에서 결제·크레딧을 확인하세요."
    )
    assert _normalize_vision_error(exc) is None
