import numpy as np

from app.video_analysis.image_io import image_to_base64_jpeg, read_image_bgr, write_image_jpg


def test_read_write_unicode_path(tmp_path):
    # 한글 경로 시뮬레이션
    sub = tmp_path / "한글폴더"
    sub.mkdir()
    p = sub / "frame_0001.jpg"
    img = np.zeros((120, 160, 3), dtype=np.uint8)
    img[:, :, 2] = 200
    assert write_image_jpg(p, img)
    loaded = read_image_bgr(p)
    assert loaded is not None
    assert loaded.shape == img.shape
    b64 = image_to_base64_jpeg(p, max_width=80)
    assert b64 and len(b64) > 100
