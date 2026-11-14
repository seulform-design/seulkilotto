"""당첨 패턴 아틀라스 — 정확 분포(8,145,060 전수)·조합 순번·DB 업서트·walk-forward 정직성."""
from __future__ import annotations

import math
import random

import numpy as np
import pytest

from app.ingest import db
from app.ingest import draw_atlas as A


@pytest.fixture()
def iso(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DB_PATH", str(tmp_path / "reg.db"))
    db.reset_for_tests()
    A.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()
    A.reset_for_tests()


def test_exact_counts_match_closed_form():
    ex = A.exact()
    assert ex["total"] == 8145060
    for f in A.FEATURES:
        assert sum(ex["dist"][f].values()) == 8145060
    for k in range(7):  # 홀수 23개·짝수 22개 초기하
        assert ex["dist"]["odd"][str(k)] == math.comb(23, k) * math.comb(22, 6 - k)
        assert ex["dist"]["low"][str(k)] == math.comb(22, k) * math.comb(23, 6 - k)
    assert sum(ex["class_counts"].values()) == 8145060
    assert ex["dist"]["sum"]["21"] == 1 and ex["dist"]["sum"]["255"] == 1


def test_combo_index_is_lexicographic_bijection():
    from itertools import combinations, islice

    for i, c in enumerate(islice(combinations(range(1, 46), 6), 2000), start=1):
        assert A.combo_index(c) == i
    assert A.combo_index([40, 41, 42, 43, 44, 45]) == 8145060


def test_python_features_match_generator():
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("gen", Path(__file__).resolve().parents[1] / "scripts" / "gen_pattern_exact.py")
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    r = random.Random(3)
    C = np.array([sorted(r.sample(range(1, 46), 6)) for _ in range(300)], dtype=np.int16)
    F = g.features(C)
    K = g.class_key_arr(F)
    for i, c in enumerate(C):
        f = A.features(c)
        for k in F:
            assert f[k] == int(F[k][i]), (k, c)
        assert A.class_key(f) == int(K[i])


def test_report_builds_db_and_stays_honest(iso):
    r = A.report()
    n = r["rounds"]
    assert n > 1000
    assert db.query("SELECT COUNT(*) FROM draw_pattern_atlas")[0][0] == n
    obs = db.query("SELECT SUM(observed) FROM pattern_exact_distribution WHERE feature = 'odd'")[0][0]
    assert obs == n
    assert r["repeats"]["distinct_winning_combos"] == n  # 같은 1등 조합 반복 없음
    assert sum(r["typicality_deciles"]["counts"]) == n
    wf = r["walk_forward"]
    assert wf["rounds"] > 1000 and wf["expected_by_exact_prob"] > 0
    assert "1/8,145,060" in r["honesty"]
    A.build()  # 재실행 = 업서트(중복 행 없음)
    assert db.query("SELECT COUNT(*) FROM draw_pattern_atlas")[0][0] == n
