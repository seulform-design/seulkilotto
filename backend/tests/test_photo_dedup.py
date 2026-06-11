from pathlib import Path

from app.video_analysis.dedup import compute_source_id, dedupe_paths_by_content


def test_dedupe_paths_by_content(tmp_path):
    a = tmp_path / "a.jpg"
    b = tmp_path / "b.jpg"
    data = b"\xff\xd8\xff" + b"same"
    a.write_bytes(data)
    b.write_bytes(data)
    c = tmp_path / "c.jpg"
    c.write_bytes(b"\xff\xd8\xff" + b"other")

    unique, removed = dedupe_paths_by_content([a, b, c])
    assert removed == 1
    assert len(unique) == 2


def test_source_id_includes_intent(tmp_path):
    p = tmp_path / "x.jpg"
    p.write_bytes(b"img")
    assert compute_source_id([p], "review") != compute_source_id([p], "current_round")
