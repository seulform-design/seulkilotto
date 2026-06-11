"""OpenCV 이미지 I/O — Windows 한글 경로 호환."""
from __future__ import annotations

import base64
from pathlib import Path

import numpy as np


def read_image_bgr(path: Path):
    """cv2.imread 대체 (유니코드 경로 지원)."""
    import cv2

    try:
        data = np.fromfile(str(path), dtype=np.uint8)
        if data.size == 0:
            return None
        return cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception:
        return None


def write_image_jpg(path: Path, img, quality: int = 85) -> bool:
    """cv2.imwrite 대체 (유니코드 경로 지원)."""
    import cv2

    try:
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if not ok:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        buf.tofile(str(path))
        return path.is_file() and path.stat().st_size > 0
    except Exception:
        return False


def image_to_base64_jpeg(path: Path, max_width: int = 640, quality: int = 75) -> str | None:
    import cv2

    img = read_image_bgr(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    if w > max_width:
        scale = max_width / w
        img = cv2.resize(img, (max_width, int(h * scale)))
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return None
    return base64.b64encode(buf).decode("ascii")
