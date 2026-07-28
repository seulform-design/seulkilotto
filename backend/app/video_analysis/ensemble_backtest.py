"""엔진 앙상블 커버리지 천장 백테스트 — 전 신호를 합친 '앙상블'이 무작위(또는 최고 단일
신호)를 이기는지 정직하게 검정한다.

⚠️ 로또는 i.i.d. 균등난수 — 이 백테스트는 확률을 못 올린다. 잭팟(1/8,145,060)은 물론
부분일치(3·4·5개) 기대값조차 45개 중 어떤 조합을 골라도 동일하다. 목적은 '확률 향상'이
아니라, **전 엔진을 합쳐도 무작위 커버리지를 유의하게 넘지 못한다**는 천장을 유의성·회차별
성적으로 투명하게 보여줘, 헛된 확신 대신 정직한 전략(넓은 커버리지 + 공동당첨 회피 EV)을
쓰게 하는 것이다.

앙상블 방식: 전 신호의 회차내 순위를 **등가중 평균(Borda)** — 성적 가중은 같은 회차로
학습해 과적합되므로 쓰지 않는다(4회차 소표본). 파라미터가 없어 과적합 여지 자체가 없다.
"""
from __future__ import annotations

from typing import Any, Dict, List

ENSEMBLE_KS = [6, 18]


def _ensemble_order(sigs: Dict[str, Dict[int, float]], signal_keys: List[str]) -> List[int]:
    """전 신호의 회차내 순위 평균(Borda)으로 번호를 정렬 — 낮을수록 강함."""
    from .review_verification import _rank_signal

    tb = sigs.get("total_freq")
    agg = {n: 0.0 for n in range(1, 46)}
    for sk in signal_keys:
        ranked = _rank_signal(sigs[sk], tb)
        for i, n in enumerate(ranked):
            agg[n] += i + 1
    # 동률은 총 등장(total_freq)으로 깨 인덱스 편향 제거(엔진 일관 기준).
    return sorted(range(1, 46), key=lambda n: (agg[n], -(tb.get(n, 0.0) if tb else 0.0), n))


def build_ensemble_backtest(samples: Any = None) -> Dict[str, Any]:
    from .feature_learning_engine import collect_round_samples
    from .review_verification import (
        SMALL_SAMPLE_ROUNDS,
        _SIGNAL_LABELS,
        _coverage_significance,
        _signal_leaderboard,
        _signals,
    )

    if samples is None:
        samples = collect_round_samples()
    rounds = len(samples)
    if rounds < 2:
        return {
            "ok": False,
            "reason": "앙상블 백테스트는 최소 2개 보관 회차가 필요합니다(추첨 전 등록 용지).",
            "rounds": rounds,
        }

    keys = list(_SIGNAL_LABELS.keys())
    ens_hits = {k: 0 for k in ENSEMBLE_KS}
    per_round: List[Dict[str, Any]] = []
    ens_pos_by_round: List[Dict[int, int]] = []
    for s in samples:
        sigs = _signals(s.auto_lines, s.semi_lines)
        order = _ensemble_order(sigs, keys)
        pos = {n: i + 1 for i, n in enumerate(order)}
        ens_pos_by_round.append(pos)
        row: Dict[str, Any] = {"round_no": s.round_no, "winning": list(s.winning)}
        for k in ENSEMBLE_KS:
            h = sum(1 for n in s.winning if pos[n] <= k)
            ens_hits[k] += h
            row[f"ens_top{k}"] = h
        per_round.append(row)

    ensemble_sig = {str(k): _coverage_significance(ens_hits[k], rounds, k) for k in ENSEMBLE_KS}
    ensemble_mean = {str(k): round(ens_hits[k] / rounds, 3) for k in ENSEMBLE_KS}

    # 최고 단일 신호(다회차 상위18) 와 비교 — 앙상블이 그보다 나은가?
    lb = _signal_leaderboard(samples)
    board = lb.get("leaderboard") or []
    best_single = board[0] if board else None
    random_top18 = round(18 * 6 / 45, 3)  # ≈ 2.4
    random_top6 = round(6 * 6 / 45, 3)    # ≈ 0.8

    beats_random = bool(ensemble_sig["18"]["significant"])
    beats_best_single = bool(
        best_single is not None and ensemble_mean["18"] > float(best_single.get("mean_top18", 0.0))
    )

    return {
        "ok": True,
        "rounds": rounds,
        "small_sample": rounds < SMALL_SAMPLE_ROUNDS,
        "ensemble_method": "Borda 평균순위(전 신호 등가중 — 과적합 방지, 파라미터 없음)",
        "signals_combined": [_SIGNAL_LABELS[k] for k in keys],
        "per_round": per_round,
        "ensemble_mean": ensemble_mean,
        "ensemble_significance": ensemble_sig,
        "best_single_signal": (
            {"label": best_single.get("label"), "mean_top18": best_single.get("mean_top18")}
            if best_single
            else None
        ),
        "random_baseline": {"top6": random_top6, "top18": random_top18},
        "beats_random": beats_random,
        "beats_best_single": beats_best_single,
        "verdict": (
            "앙상블이 무작위를 유의하게 초과 — 단, 소표본이면 우연 가능."
            if beats_random
            else "앙상블도 무작위 커버리지와 통계적으로 구분되지 않음(천장). 전 엔진을 합쳐도 확률·커버리지 기대값은 불변."
        ),
        "honesty": (
            "로또는 i.i.d. — 확률(1/8,145,060)도 부분일치 기대값도 어떤 앙상블로도 안 변합니다. "
            "이 백테스트는 '전 엔진을 합치면 무작위를 이기나?'를 정직하게 검정할 뿐이며, 현재 "
            f"{rounds}개 회차 소표본에선 유의한 초과가 거의 없습니다(천장). 회차가 쌓이면 실제 "
            "초과가 있다면 자동으로 유의해집니다. 유일한 실질 레버는 당첨 시 기대수령액(공동당첨 회피)입니다."
        ),
    }
