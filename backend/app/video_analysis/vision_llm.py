"""OpenAI Vision API — 손글씨·자동번호표 고정밀 분석 (선택)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

from .overlap_patterns import build_frequency_overlap_patterns
from .vision import frame_to_base64_preview

VISION_PROMPT = """# Role: Video-Frame Lotto Pattern Analysis Engine

# Input Context
The input is a sequence of video frames (images) extracted from a YouTube lotto analysis video. The video contains visual sheets, blackboards, or printed automatic tickets with handwritten marks, circles, lines, or geometric patterns.

# Task
Visually scan the sequence of video frames to identify the final or most complete lotto analysis board. Analyze the written numbers, circled duplicates (pairs, multiples), and drawn lines (diagonals, intersections) just like a human lotto analyst. Output the results STRICTLY as a valid JSON object.

Return ONLY a JSON object structured exactly as follows (no markdown, no extra text):

{
  "video_visual_analysis": {
    "detected_round": "string or null — the round printed ON the lotto auto-ticket/sheet (용지 회차), not review round",
    "main_board_summary": "string"
  },
  "extracted_visual_patterns": {
    "identified_multiples": {
      "type": "string (e.g., '쌍수' for pairs only)",
      "numbers": [integer]
    },
    "frequency_overlap_patterns": {
      "summary": "자동용지 번호 출현 빈도 분석",
      "all_frequent": [{"number": integer, "overlap_count": integer}],
      "tiers": [
        {
          "min_count": 2,
          "label": "2회이상",
          "pattern_type": "쌍수",
          "items": [{"number": integer, "overlap_count": integer}]
        }
      ]
    },
    "line_patterns": [
      {
        "target_number": integer,
        "pattern_type": "string (e.g., 'diagonal line', 'vertical stack', 'horizontal block')"
      }
    ]
  },
  "final_predictions": {
    "strong_candidates": [integer],
    "excluded_candidates": [integer]
  },
  "app_ui_message": "string"
}
"""


def _format_vision_api_error(status: int, detail: str) -> str:
    lower = (detail or "").lower()
    if status == 429 or "insufficient_quota" in lower or "exceeded your current quota" in lower:
        return (
            "OpenAI Vision API 사용 한도/잔액이 없습니다. "
            "https://platform.openai.com/account/billing 에서 결제·크레딧을 확인하거나 "
            "유효한 API 키로 backend/.env 의 VIDEO_VISION_API_KEY 를 갱신하세요."
        )
    if status == 401:
        return "OpenAI API 키가 유효하지 않습니다. VIDEO_VISION_API_KEY 를 확인하세요."
    return f"Vision API 오류 ({status}): {detail[:200]}"


def _extract_json(text: str) -> Dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("Vision 응답에서 JSON을 찾지 못했습니다.")
    return json.loads(text[start : end + 1])


def _sanitize_result(raw: Dict[str, Any]) -> Dict[str, Any]:
    def ints(xs: Any) -> List[int]:
        out: List[int] = []
        if not isinstance(xs, list):
            return out
        for x in xs:
            try:
                n = int(x)
                if 1 <= n <= 45:
                    out.append(n)
            except (TypeError, ValueError):
                continue
        return sorted(set(out))

    vva = raw.get("video_visual_analysis") or {}
    evp = raw.get("extracted_visual_patterns") or {}
    im = evp.get("identified_multiples") or {}
    fop_raw = evp.get("frequency_overlap_patterns") or {}
    fp = raw.get("final_predictions") or {}

    freq_counts: Dict[int, int] = {}
    for item in fop_raw.get("all_frequent") or []:
        if not isinstance(item, dict):
            continue
        try:
            n = int(item.get("number"))
            c = int(item.get("overlap_count", 2))
            if 1 <= n <= 45:
                freq_counts[n] = max(freq_counts.get(n, 0), c)
        except (TypeError, ValueError):
            pass
    for tier in fop_raw.get("tiers") or []:
        for item in tier.get("items") or []:
            try:
                n = int(item.get("number"))
                c = int(item.get("overlap_count", 2))
                if 1 <= n <= 45:
                    freq_counts[n] = max(freq_counts.get(n, 0), c)
            except (TypeError, ValueError):
                pass
    fop = build_frequency_overlap_patterns(freq_counts)

    line_patterns: List[Dict[str, Any]] = []
    for lp in evp.get("line_patterns") or []:
        if not isinstance(lp, dict):
            continue
        try:
            tn = int(lp.get("target_number"))
        except (TypeError, ValueError):
            continue
        if 1 <= tn <= 45:
            line_patterns.append(
                {
                    "target_number": tn,
                    "pattern_type": str(lp.get("pattern_type") or "line"),
                }
            )

    detected = vva.get("detected_round")
    if detected is not None:
        detected = str(detected).strip() or None

    return {
        "video_visual_analysis": {
            "detected_round": detected,
            "main_board_summary": str(vva.get("main_board_summary") or "").strip(),
        },
        "extracted_visual_patterns": {
            "identified_multiples": {
                "type": str(im.get("type") or "중복없음"),
                "numbers": ints(im.get("numbers")),
            },
            "frequency_overlap_patterns": fop,
            "triple_plus_overlap": fop["triple_plus_overlap"],
            "line_patterns": line_patterns[:20],
        },
        "final_predictions": {
            "strong_candidates": ints(fp.get("strong_candidates")),
            "excluded_candidates": ints(fp.get("excluded_candidates")),
        },
        "app_ui_message": str(raw.get("app_ui_message") or "").strip(),
    }


def analyze_frames_with_vision(
    frame_paths: List[Path],
    *,
    api_key: str,
    model: str = "gpt-4o-mini",
    video_title: str = "",
) -> Dict[str, Any]:
    """키 프레임 최대 4장을 Vision API로 분석."""
    images: List[Dict[str, Any]] = []
    for p in frame_paths[:4]:
        b64 = frame_to_base64_preview(p, max_width=1024)
        if b64:
            images.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"},
                }
            )
    if not images:
        raise RuntimeError("Vision API에 전송할 프레임 이미지가 없습니다.")

    user_text = VISION_PROMPT
    if video_title:
        user_text += f"\n\nVideo title: {video_title}"

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [{"type": "text", "text": user_text}, *images],
            }
        ],
        "temperature": 0.2,
        "max_tokens": 1200,
    }

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(_format_vision_api_error(e.code, detail)) from e

    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError("Vision API 응답이 비어 있습니다.")
    content = (choices[0].get("message") or {}).get("content") or ""
    parsed = _extract_json(content)
    return _sanitize_result(parsed)
