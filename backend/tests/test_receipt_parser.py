from pathlib import Path

import pytest

# easyocr/torch 가 없으면(예: CI 의 경량 설치) OCR 테스트 전체를 건너뛴다.
# easyocr 는 앱에서 지연 임포트되어 본 기능엔 영향 없고, CI 러너에서 torch
# 모델 로드가 메모리/네트워크로 불안정(프로세스 강제종료 → exit 2)했던 원인.
pytest.importorskip("easyocr", reason="easyocr/torch 미설치 — OCR 테스트 생략")

from app.video_analysis.line_overlap_patterns import extract_betting_lines
from app.video_analysis.receipt_parser import (
    RECEIPT_LAYOUT,
    looks_like_printed_receipt,
    parse_receipt_lines,
)
from app.video_analysis.sheet_grid import detect_all_sheets_in_image

FIXTURE = Path(__file__).parent / "fixtures" / "receipt_5x6_sample.png"

EXPECTED = {
    "A": [12, 14, 22, 25, 38, 42],
    "B": [7, 10, 24, 25, 38, 41],
    "C": [12, 27, 32, 37, 38, 44],
    "D": [1, 2, 5, 12, 18, 32],
    "E": [11, 14, 15, 16, 32, 39],
}


@pytest.mark.skipif(not FIXTURE.is_file(), reason="receipt fixture missing")
def test_receipt_fixture_detected():
    from app.video_analysis.image_io import read_image_bgr

    img = read_image_bgr(FIXTURE)
    assert img is not None
    assert looks_like_printed_receipt(img)


@pytest.mark.skipif(not FIXTURE.is_file(), reason="receipt fixture missing")
def test_parse_receipt_5x6_lines():
    from app.video_analysis.image_io import read_image_bgr

    img = read_image_bgr(FIXTURE)
    lines = parse_receipt_lines(img)
    assert lines is not None
    assert len(lines) == 5
    for line in lines:
        label = line["label"]
        assert line["source_layout"] == RECEIPT_LAYOUT
        assert sorted(line["numbers"]) == EXPECTED[label]


@pytest.mark.skipif(not FIXTURE.is_file(), reason="receipt fixture missing")
def test_detect_all_sheets_uses_receipt_not_grid():
    sheets = detect_all_sheets_in_image(FIXTURE)
    assert len(sheets) == 1
    sheet = sheets[0]
    assert sheet.get("layout_mode") == RECEIPT_LAYOUT
    lines = sheet.get("lines") or []
    assert len(lines) == 5
    by_label = {ln["label"]: sorted(ln["numbers"]) for ln in lines}
    assert by_label == EXPECTED

    betting = extract_betting_lines([{**sheet, "image_index": 1}])
    assert len(betting) == 5
    for row in betting:
        assert sorted(row["numbers"]) == EXPECTED[row["line_label"]]
