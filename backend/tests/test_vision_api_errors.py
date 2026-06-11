from app.video_analysis.vision_llm import _format_vision_api_error


def test_quota_error_message():
    msg = _format_vision_api_error(
        429,
        '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
    )
    assert "한도" in msg or "잔액" in msg
    assert "billing" in msg
