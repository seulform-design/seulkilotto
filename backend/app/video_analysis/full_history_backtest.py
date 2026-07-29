"""전체 당첨 이력 워크포워드 백테스트 — '로또의 모든 데이터'로 후보 전략(빈도/미출/최근/
페어)이 무작위를 이기는지 통계적 힘(수백~1200+ 회차)으로 정직하게 검정한다.

⚠️ 로또는 i.i.d. 균등난수 — 어떤 전략도 미래 draw 를 예측할 수 없고 확률(1/8,145,060)은
불변이다. 용지 4회차 백테스트는 표본이 작아 검정력이 약했지만, 전체 이력으로 워크포워드하면
아주 작은 실제 우위조차 잡아낼 검정력이 생긴다. 그럼에도 어떤 전략도 무작위를 유의하게
못 이긴다는 걸 **최대 데이터로 확정**하는 것이 이 엔진의 값어치다(정직한 천장, 확률 불변).

누수 없음(walk-forward): 각 회차 R 은 R 이전 회차만으로 순위를 매기고 R 의 당첨 6개로
채점한다. 회차 독립 초기하 합으로 유의성(정규근사)을 산출한다.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

BASE = 6.0 / 45.0
DEFAULT_KS = [6, 18]
WARMUP = 50  # 초반 표본이 쌓일 때까지 채점에서 제외

_STRATEGY_LABELS = {
    "hot": "핫(누적 최다 출현)",
    "cold": "콜드(누적 최소 출현)",
    "overdue": "미출(오래 안 나온 순)",
    "recent": "최근 출현(모멘텀)",
    "pair_hot": "직전 당첨과 동반 최다(페어)",
    "last_avoid": "직전 회차 번호 회피",
}


def _decade(n: int) -> int:
    return min(4, (n - 1) // 10)


def _winning_rounds() -> List[Tuple[int, List[int]]]:
    from .feature_learning_engine import _winning_by_round

    wm = _winning_by_round()
    return [(r, wm[r]) for r in sorted(wm.keys())]


def build_full_history_backtest(ks: List[int] | None = None, warmup: int = WARMUP) -> Dict[str, Any]:
    from .review_verification import _coverage_significance
    from .stats import expected_false_positives

    ks = ks or DEFAULT_KS
    rounds = _winning_rounds()
    n_total = len(rounds)
    if n_total < warmup + 20:
        return {"ok": False, "reason": f"당첨 이력이 부족합니다({n_total} < {warmup + 20}).", "total_rounds": n_total}

    freq = [0] * 46
    last_seen = [0] * 46          # 마지막으로 뽑힌 처리 인덱스(1-based)
    pair = [[0] * 46 for _ in range(46)]
    strategies = list(_STRATEGY_LABELS.keys())
    hits = {s: {k: 0 for k in ks} for s in strategies}
    tested = 0
    prev_winners: List[int] = []

    for idx, (_rnd, raw) in enumerate(rounds):
        winners = [int(w) for w in raw if 1 <= int(w) <= 45][:6]
        if not winners:
            continue
        if idx >= warmup:
            processed = idx  # 지금까지 본 회차 수
            hot = sorted(range(1, 46), key=lambda n: (-freq[n], n))
            cold = sorted(range(1, 46), key=lambda n: (freq[n], n))
            overdue = sorted(range(1, 46), key=lambda n: (-(processed - last_seen[n]), n))
            recent = sorted(range(1, 46), key=lambda n: (-last_seen[n], n))
            if prev_winners:
                pair_sc = [sum(pair[n][w] for w in prev_winners) for n in range(46)]
            else:
                pair_sc = list(freq)
            pair_hot = sorted(range(1, 46), key=lambda n: (-pair_sc[n], n))
            prev_set = set(prev_winners)
            # 직전 회차 번호를 뒤로, 나머지는 hot 순 — '지난 번호 회피' 민속 전략.
            last_avoid = sorted(range(1, 46), key=lambda n: (1 if n in prev_set else 0, -freq[n], n))
            rankmap = {
                "hot": hot, "cold": cold, "overdue": overdue,
                "recent": recent, "pair_hot": pair_hot, "last_avoid": last_avoid,
            }
            wset = set(winners)
            for s in strategies:
                rk = rankmap[s]
                for k in ks:
                    hits[s][k] += sum(1 for n in rk[:k] if n in wset)
            tested += 1
        # 통계 갱신(이 회차 반영) — 채점 후에 해야 누수 없음.
        for w in winners:
            freq[w] += 1
            last_seen[w] = idx + 1
        for i in range(len(winners)):
            for j in range(i + 1, len(winners)):
                a, b = winners[i], winners[j]
                pair[a][b] += 1
                pair[b][a] += 1
        prev_winners = winners

    # ⚠️ 다중검정 보정 — 전략×K 를 여러 번 검정하면 순수 우연으로도 일부가 'p<0.05'로
    # 나온다(콜드 top18 p≈0.026 같은 위양성). Bonferroni α=0.05/N 로 보정해야 진짜 우위와
    # 우연 위양성을 구분한다. N = 전략수 × K수.
    n_tests = len(strategies) * len(ks)
    mt = expected_false_positives(n_tests, 0.05)
    bonf_alpha = mt["bonferroni_alpha"]

    results: List[Dict[str, Any]] = []
    raw_sig_count = 0
    for s in strategies:
        by_k: Dict[str, Any] = {}
        for k in ks:
            sig = _coverage_significance(hits[s][k], tested, k)
            raw_sig = bool(sig["p_value"] < 0.05 and hits[s][k] > tested * k * BASE)
            bonf_sig = bool(sig["p_value"] < bonf_alpha and hits[s][k] > tested * k * BASE)
            if raw_sig:
                raw_sig_count += 1
            by_k[str(k)] = {
                "hits": hits[s][k],
                "mean_per_round": round(hits[s][k] / tested, 3) if tested else 0.0,
                "expected_per_round": round(k * BASE, 3),
                "lift": sig["lift"],
                "p_value": sig["p_value"],
                "significant_raw": raw_sig,           # 다중검정 미보정(참고)
                "significant": bonf_sig,              # 보정 후 — 진짜 우위 판정
            }
        results.append({"strategy": s, "label": _STRATEGY_LABELS[s], "by_k": by_k})
    results.sort(key=lambda r: -r["by_k"][str(ks[-1])]["mean_per_round"])
    any_sig = any(r["by_k"][str(k)]["significant"] for r in results for k in ks)

    return {
        "ok": True,
        "total_rounds": n_total,
        "tested_rounds": tested,
        "warmup": warmup,
        "random_baseline": {str(k): round(k * BASE, 3) for k in ks},
        "strategies": results,
        "multiple_testing": {
            **mt,
            "raw_significant_count": raw_sig_count,
            "note": "다중검정 미보정 'p<0.05' 개수 vs 우연 기대치(N×0.05). 초과하지 못하면 우연.",
        },
        "any_beats_random": any_sig,  # Bonferroni 보정 후
        "verdict": (
            "Bonferroni 보정 후에도 무작위를 유의하게 초과하는 전략이 있습니다 — 재현 재확인 필요."
            if any_sig
            else (
                f"전체 {tested}개 회차 워크포워드 결과, 어떤 전략(핫·콜드·미출·최근·페어·회피)도 "
                f"무작위 커버리지를 유의하게 이기지 못했습니다. 미보정 'p<0.05'가 {raw_sig_count}개 "
                f"나왔지만(예: 콜드 top18), 이는 {n_tests}회 검정에서 우연히 기대되는 "
                f"~{mt['expected_false_positives']}개 수준의 다중검정 위양성이며 Bonferroni "
                f"기준(p<{bonf_alpha})을 통과하지 못합니다. 큰 표본으로도 진짜 우위가 없다는 것은 "
                "로또가 i.i.d. 라는 직접 증거입니다 — 확률은 어떤 전략으로도 안 변합니다."
            )
        ),
        "honesty": (
            "각 회차는 이전 회차만으로 예측하고 그 회차로 채점(walk-forward, 누수 없음). "
            "표본이 커서 아주 작은 실제 우위도 잡아낼 검정력이 있음에도, 다중검정 보정 후 유의한 "
            "초과가 없다는 것이 핵심입니다. 1등 확률(1/8,145,060)·부분일치 기대값은 어떤 선택으로도 "
            "불변이며, 유일한 실질 레버는 당첨 시 기대수령액(공동당첨 회피)입니다."
        ),
    }
