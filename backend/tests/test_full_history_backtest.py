"""전체 당첨 이력 워크포워드 백테스트 회귀 테스트.

walk-forward(누수 없음) + 다중검정 보정이 올바른지, 그리고 큰 표본으로도 어떤 흔한 전략
(핫/콜드/미출/최근/페어/회피)도 무작위를 (보정 후) 이기지 못한다는 정직한 결론을 검증한다.
⚠️ 로또 i.i.d. — 확률 불변. 이 테스트가 실패하면 데이터 오류(누수·중복)일 가능성이 높다.
"""
from app.video_analysis.full_history_backtest import build_full_history_backtest


def test_structure_and_multiple_testing():
    r = build_full_history_backtest()
    assert r["ok"] is True
    assert r["tested_rounds"] > 100
    assert len(r["strategies"]) == 6
    mt = r["multiple_testing"]
    assert mt["n_tested"] == 12  # 6 전략 × 2 K
    assert 0 < mt["bonferroni_alpha"] < 0.05
    for s in r["strategies"]:
        for k in ("6", "18"):
            cell = s["by_k"][k]
            assert "p_value" in cell and "significant_raw" in cell and "significant" in cell
            # Bonferroni 유의는 미보정 유의의 부분집합(더 엄격).
            if cell["significant"]:
                assert cell["significant_raw"]


def test_no_strategy_beats_random_after_correction():
    # i.i.d. — 다중검정 보정 후 무작위를 이기는 전략은 없어야 한다(정직한 천장).
    r = build_full_history_backtest()
    assert r["any_beats_random"] is False


def test_means_near_random_baseline():
    # 모든 전략의 top18 평균이 무작위 기대(2.4) 근처(±0.3) — 큰 우위 없음.
    r = build_full_history_backtest()
    base = r["random_baseline"]["18"]
    for s in r["strategies"]:
        assert abs(s["by_k"]["18"]["mean_per_round"] - base) < 0.3
