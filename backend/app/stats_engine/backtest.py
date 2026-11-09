"""전체 당첨 이력 walk-forward 백테스트 (용지 모듈 비의존).

흔한 전략(핫/콜드/미출/최근/페어/직전회피)이 무작위를 이기는지, 전체 이력(1200+ 회차)의
검정력으로 정직하게 확인한다.

누수 방지(시간 순서 검증)
------------------------
회차 R 의 순위는 R 이전 회차만으로 매기고, R 의 본번호 6개로 채점한 **뒤에** R 을 통계에
반영한다. 보너스 번호는 채점·통계 어디에도 섞지 않는다. 전략 정의·K·워밍업은 사전에
고정된 값이며 백테스트 결과로 조정하지 않는다(사후 최적화 금지) — 그래서 결과는 탐색이
아니라 확인(confirmatory) 검정이다.

과적합 점검
----------
전반부/후반부로 나눈 `period_split` 를 함께 낸다. 진짜 우위라면 두 기간 모두에서 같은
방향으로 나타나야 한다. 한쪽에서만 '유의'하면 우연/특정 구간 편향으로 본다.

⚠️ 로또는 i.i.d. — 확률(1/8,145,060)은 어떤 전략으로도 불변.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import ENGINE_VERSION
from .cache import cached
from .draws import Draw, data_signature, load_draws
from .significance import coverage_significance, expected_false_positives

ALGORITHM_VERSION = "full-history-backtest-2.0"
BASE = 6.0 / 45.0
DEFAULT_KS = [6, 18]
WARMUP = 50  # 초반 표본이 쌓일 때까지 채점에서 제외

STRATEGY_LABELS = {
    "hot": "핫(누적 최다 출현)",
    "cold": "콜드(누적 최소 출현)",
    "overdue": "미출(오래 안 나온 순)",
    "recent": "최근 출현(모멘텀)",
    "pair_hot": "직전 당첨과 동반 최다(페어)",
    "last_avoid": "직전 회차 번호 회피",
}
_STRATEGY_LABELS = STRATEGY_LABELS  # 하위 호환 이름


def _rankings(freq, last_seen, pair, prev_winners, processed) -> Dict[str, List[int]]:
    nums = range(1, 46)
    if prev_winners:
        pair_sc = [sum(pair[n][w] for w in prev_winners) for n in range(46)]
    else:
        pair_sc = list(freq)
    prev_set = set(prev_winners)
    return {
        "hot": sorted(nums, key=lambda n: (-freq[n], n)),
        "cold": sorted(nums, key=lambda n: (freq[n], n)),
        "overdue": sorted(nums, key=lambda n: (-(processed - last_seen[n]), n)),
        "recent": sorted(nums, key=lambda n: (-last_seen[n], n)),
        "pair_hot": sorted(nums, key=lambda n: (-pair_sc[n], n)),
        # 직전 회차 번호를 뒤로, 나머지는 hot 순 — '지난 번호 회피' 민속 전략.
        "last_avoid": sorted(nums, key=lambda n: (1 if n in prev_set else 0, -freq[n], n)),
    }


def _walk_forward(draws: List[Draw], ks: List[int], warmup: int, tickets: Optional[Dict[str, Any]] = None):
    """회차별 적중 시계열 — per_round[s][k] = [hits_r ...] (채점 회차 순).

    `tickets` 가 주어지면 전략별 '6개 1장'(순위 상위 6) 의 회차별 (본번호 일치 수, 보너스 포함
    여부) 를 tickets[s] 리스트에 함께 기록한다(등수 분포 채점용 — 같은 누수 없는 패스)."""
    freq = [0] * 46
    last_seen = [0] * 46  # 마지막으로 뽑힌 처리 인덱스(1-based)
    pair = [[0] * 46 for _ in range(46)]
    per_round = {s: {k: [] for k in ks} for s in STRATEGY_LABELS}
    tested_rounds: List[int] = []
    prev: List[int] = []
    for idx, d in enumerate(draws):
        winners = list(d.numbers)
        if idx >= warmup:
            ranks = _rankings(freq, last_seen, pair, prev, idx)
            wset = set(winners)
            for s, rk in ranks.items():
                for k in ks:
                    per_round[s][k].append(sum(1 for n in rk[:k] if n in wset))
                if tickets is not None:
                    t6 = rk[:6]
                    tickets.setdefault(s, []).append(
                        (sum(1 for n in t6 if n in wset), d.bonus in t6, tuple(n for n in t6 if n in wset))
                    )
            tested_rounds.append(d.round)
        # 채점 후 갱신 — 누수 없음
        for w in winners:
            freq[w] += 1
            last_seen[w] = idx + 1
        for i in range(6):
            for j in range(i + 1, 6):
                a, b = winners[i], winners[j]
                pair[a][b] += 1
                pair[b][a] += 1
        prev = winners
    return per_round, tested_rounds


def _cell(hits: int, tested: int, k: int, bonf_alpha: float) -> Dict[str, Any]:
    sig = coverage_significance(hits, tested, k)
    above = hits > tested * k * BASE
    return {
        "hits": hits,
        "mean_per_round": round(hits / tested, 3) if tested else 0.0,
        "expected_per_round": round(k * BASE, 3),
        "lift": sig["lift"],
        "p_value": sig["p_value"],
        "ci95_mean": sig.get("ci95"),
        "significant_raw": bool(sig["p_value"] < 0.05 and above),  # 다중검정 미보정(참고)
        "significant": bool(sig["p_value"] < bonf_alpha and above),  # 보정 후 — 판정
    }


def _compute(draws: List[Draw], ks: List[int], warmup: int) -> Dict[str, Any]:
    n_total = len(draws)
    if n_total < warmup + 20:
        return {
            "ok": False,
            "reason": f"당첨 이력이 부족합니다({n_total} < {warmup + 20}).",
            "total_rounds": n_total,
            "algorithm_version": ALGORITHM_VERSION,
        }
    per_round, tested_rounds = _walk_forward(draws, ks, warmup)
    tested = len(tested_rounds)
    strategies = list(STRATEGY_LABELS)

    # ⚠️ 다중검정 보정 — 전략×K 를 여러 번 검정하면 우연으로도 일부가 'p<0.05'.
    n_tests = len(strategies) * len(ks)
    mt = expected_false_positives(n_tests, 0.05)
    bonf_alpha = mt["bonferroni_alpha"]

    results: List[Dict[str, Any]] = []
    raw_sig_count = 0
    half = tested // 2
    split_flags: List[bool] = []
    for s in strategies:
        by_k: Dict[str, Any] = {}
        split: Dict[str, Any] = {}
        for k in ks:
            series = per_round[s][k]
            cell = _cell(sum(series), tested, k, bonf_alpha)
            raw_sig_count += int(cell["significant_raw"])
            by_k[str(k)] = cell
            first, second = series[:half], series[half:]
            a = coverage_significance(sum(first), len(first), k)
            b = coverage_significance(sum(second), len(second), k)
            consistent = bool(a["lift"] > 1 and b["lift"] > 1 and a["p_value"] < 0.05 and b["p_value"] < 0.05)
            split_flags.append(consistent)
            split[str(k)] = {
                "first_half": {"rounds": len(first), "lift": a["lift"], "p_value": a["p_value"]},
                "second_half": {"rounds": len(second), "lift": b["lift"], "p_value": b["p_value"]},
                "consistent_edge": consistent,
            }
        results.append({"strategy": s, "label": STRATEGY_LABELS[s], "by_k": by_k, "period_split": split})
    results.sort(key=lambda r: -r["by_k"][str(ks[-1])]["mean_per_round"])
    any_sig = any(r["by_k"][str(k)]["significant"] for r in results for k in ks)

    return {
        "ok": True,
        "total_rounds": n_total,
        "tested_rounds": tested,
        "first_tested_round": tested_rounds[0],
        "last_tested_round": tested_rounds[-1],
        "warmup": warmup,
        "sample_size": {"rounds": tested, "numbers_scored_per_round": 6},
        "random_baseline": {str(k): round(k * BASE, 3) for k in ks},
        "strategies": results,
        "multiple_testing": {
            **mt,
            "raw_significant_count": raw_sig_count,
            "note": "다중검정 미보정 'p<0.05' 개수 vs 우연 기대치(N×0.05). 초과하지 못하면 우연.",
        },
        "any_beats_random": any_sig,  # Bonferroni 보정 후
        "any_consistent_across_periods": any(split_flags),
        "verdict": (
            "Bonferroni 보정 후에도 무작위를 유의하게 초과하는 전략이 있습니다 — 재현 재확인 필요."
            if any_sig
            else (
                f"전체 {tested}개 회차 워크포워드 결과, 어떤 전략(핫·콜드·미출·최근·페어·회피)도 "
                f"무작위 커버리지를 유의하게 이기지 못했습니다. 미보정 'p<0.05'가 {raw_sig_count}개 "
                f"나왔지만, 이는 {n_tests}회 검정에서 우연히 기대되는 "
                f"~{mt['expected_false_positives']}개 수준의 다중검정 위양성이며 Bonferroni "
                f"기준(p<{bonf_alpha})을 통과하지 못합니다. 큰 표본으로도 진짜 우위가 없다는 것은 "
                "로또가 i.i.d. 라는 직접 증거입니다 — 확률은 어떤 전략으로도 안 변합니다."
            )
        ),
        "honesty": (
            "각 회차는 이전 회차만으로 예측하고 그 회차로 채점(walk-forward, 누수 없음). "
            "전략·K·워밍업은 사전 고정이며 결과로 재조정하지 않습니다(사후 최적화 없음). "
            "1등 확률(1/8,145,060)·부분일치 기대값은 어떤 선택으로도 불변이며, 유일한 실질 "
            "레버는 당첨 시 기대수령액(공동당첨 회피)입니다."
        ),
        "algorithm_version": ALGORITHM_VERSION,
        "engine_version": ENGINE_VERSION,
    }


def build_full_history_backtest(
    ks: Optional[List[int]] = None,
    warmup: int = WARMUP,
    draws: Optional[List[Draw]] = None,
) -> Dict[str, Any]:
    """전체 이력 walk-forward 백테스트. `draws` 미지정 시 현재 이력(시그니처 캐시)."""
    ks = sorted(set(int(k) for k in (ks or DEFAULT_KS)))
    if draws is not None:
        return _compute(draws, ks, warmup)
    draws = load_draws()
    sig = data_signature(draws)
    res = cached("full_history_backtest", sig, (tuple(ks), int(warmup)),
                 lambda: _compute(draws, ks, warmup))
    out = dict(res)
    out["data_signature"] = sig
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 6개 1장(티켓) 단위 백테스트 — 등수 분포 + 무작위 Monte Carlo 기준선 (2026-11-10 추가)
# ─────────────────────────────────────────────────────────────────────────────

TICKET_ALGORITHM_VERSION = "ticket-backtest-1.0"
RANDOM_REPS_DEFAULT = 200
RANDOM_SEED = 20261110  # 사전 고정(결과 보고 바꾸지 않음)
N_PERIODS = 4


def _match_hist(rows) -> Dict[str, int]:
    """[(matches, bonus_in_ticket, hit_numbers)] → 일치 개수/등수 카운트."""
    h = {str(k): 0 for k in range(7)}
    five_bonus = 0
    for m, b_in, _hits in rows:
        h[str(m)] += 1
        if m == 5 and b_in:
            five_bonus += 1
    return {
        **h,
        "five_plus_bonus": five_bonus,
        "prize_1": h["6"],
        "prize_2": five_bonus,
        "prize_3": h["5"] - five_bonus,
        "prize_4": h["4"],
        "prize_5": h["3"],
    }


def _random_baseline(draws: List[Draw], warmup: int, reps: int, seed: int) -> Dict[str, Any]:
    """같은 채점 회차·같은 규칙으로 무작위 6개 티켓 reps 장씩 — Monte Carlo 기준선."""
    import numpy as np

    rng = np.random.default_rng(seed)
    tested = draws[warmup:]
    n = len(tested)
    if n == 0 or reps <= 0:
        return {"reps": 0}
    win = np.zeros((n, 46), dtype=bool)
    bon = np.zeros(n, dtype=int)
    for i, d in enumerate(tested):
        win[i, list(d.numbers)] = True
        bon[i] = d.bonus
    counts = np.zeros(7, dtype=np.int64)
    five_bonus = 0
    rep_means = np.zeros(reps)
    rows_idx = np.arange(n)[:, None]
    for r in range(reps):
        tix = np.argsort(rng.random((n, 45)), axis=1)[:, :6] + 1  # 회차별 무작위 6개(중복 없음)
        m = win[rows_idx, tix].sum(axis=1)
        counts += np.bincount(m, minlength=7)
        b_in = (tix == bon[:, None]).any(axis=1)
        five_bonus += int(((m == 5) & b_in).sum())
        rep_means[r] = m.mean()
    total = n * reps
    return {
        "kind": "simulation",
        "reps": reps,
        "seed": seed,
        "tickets": int(total),
        "mean_matches": round(float(counts @ np.arange(7)) / total, 4),
        "rep_mean_sd": round(float(rep_means.std(ddof=1)), 4) if reps > 1 else 0.0,
        "rep_mean_p2_5": round(float(np.percentile(rep_means, 2.5)), 4),
        "rep_mean_p97_5": round(float(np.percentile(rep_means, 97.5)), 4),
        "distribution_rate": {str(k): round(float(counts[k]) / total, 6) for k in range(7)},
        "five_plus_bonus_rate": round(five_bonus / total, 8),
    }


def _ticket_compute(draws: List[Draw], warmup: int, reps: int, seed: int) -> Dict[str, Any]:
    from .probability import match_pmf
    from .significance import chi_square_gof

    n_total = len(draws)
    if n_total < warmup + 20:
        return {"ok": False, "reason": f"당첨 이력이 부족합니다({n_total} < {warmup + 20}).",
                "total_rounds": n_total, "algorithm_version": TICKET_ALGORITHM_VERSION}
    tickets: Dict[str, Any] = {}
    _per, tested_rounds = _walk_forward(draws, [6], warmup, tickets=tickets)
    n = len(tested_rounds)
    pmf_frac = match_pmf()
    pmf = [float(x) for x in pmf_frac]
    exp_mean = float(sum(k * pmf_frac[k] for k in range(7)))  # 정확히 0.8
    strategies = list(STRATEGY_LABELS)
    n_tests = len(strategies)
    mt = expected_false_positives(n_tests, 0.05)
    period_size = max(1, n // N_PERIODS)

    out_rows: List[Dict[str, Any]] = []
    for s in strategies:
        rows = tickets.get(s, [])
        hist = _match_hist(rows)
        total_matches = sum(r[0] for r in rows)
        sig = coverage_significance(total_matches, n, 6)
        # 일치 수 분포 vs 이론 초기하 — 3개 이상은 기대도수가 작아 한 칸으로 합침
        obs = [hist["0"], hist["1"], hist["2"], sum(hist[str(k)] for k in range(3, 7))]
        exp = [pmf[0] * n, pmf[1] * n, pmf[2] * n, sum(pmf[3:]) * n]
        gof = chi_square_gof(obs, exp)
        per_num = [0] * 46
        for _m, _b, hit_nums in rows:
            for x in hit_nums:
                per_num[x] += 1
        periods = []
        for pi in range(N_PERIODS):
            lo = pi * period_size
            hi = n if pi == N_PERIODS - 1 else (pi + 1) * period_size
            seg = rows[lo:hi]
            if not seg:
                continue
            seg_sig = coverage_significance(sum(r[0] for r in seg), len(seg), 6)
            periods.append({
                "period": pi + 1,
                "first_round": tested_rounds[lo],
                "last_round": tested_rounds[hi - 1],
                "rounds": len(seg),
                "mean_matches": round(sum(r[0] for r in seg) / len(seg), 4),
                "lift": seg_sig["lift"],
                "p_value": seg_sig["p_value"],
            })
        out_rows.append({
            "strategy": s,
            "label": STRATEGY_LABELS[s],
            "tickets": n,
            "match_counts": hist,
            "mean_matches": round(total_matches / n, 4),
            "expected_mean_matches": round(exp_mean, 4),
            "effect_size_lift": sig["lift"],
            "ci95_mean_matches": sig.get("ci95"),
            "z": sig["z"],
            "p_value": sig["p_value"],
            "significant_bonferroni": bool(sig["p_value"] < mt["bonferroni_alpha"] and total_matches > n * exp_mean),
            "distribution_test": gof,
            "number_hit_frequency": {str(x): per_num[x] for x in range(1, 46)},
            "periods": periods,
            "consistent_across_periods": bool(periods and all(p["lift"] > 1 and p["p_value"] < 0.05 for p in periods)),
        })
    out_rows.sort(key=lambda r: -r["mean_matches"])
    rnd = _random_baseline(draws, warmup, reps, seed)
    any_sig = any(r["significant_bonferroni"] for r in out_rows)
    return {
        "ok": True,
        "kind": "backtest",  # 수학적 확률과 구분
        "total_rounds": n_total,
        "tested_rounds": n,
        "first_tested_round": tested_rounds[0],
        "last_tested_round": tested_rounds[-1],
        "warmup": warmup,
        "ticket_rule": "각 회차마다 전략 순위 상위 6개를 1장으로 구매했다고 가정(그 회차 이전 데이터만 사용).",
        "theoretical": {
            "kind": "mathematical",
            "match_pmf": {str(k): pmf[k] for k in range(7)},
            "expected_mean_matches": round(exp_mean, 4),
            "expected_counts": {str(k): round(pmf[k] * n, 3) for k in range(7)},
        },
        "random_baseline": rnd,
        "strategies": out_rows,
        "multiple_testing": mt,
        "any_beats_random": any_sig,
        "verdict": (
            "Bonferroni 보정 후 무작위 대비 유의한 전략이 있습니다 — 독립 기간 재현 확인 필요."
            if any_sig
            else f"{n}회차 × 전략 {n_tests}개: 6개 1장 기준 평균 일치 수가 이론값 {round(exp_mean, 3)}·무작위 "
                 f"Monte Carlo({rnd.get('reps')}회 반복)와 통계적으로 구분되지 않습니다."
        ),
        "honesty": "백테스트 성적은 과거 기록일 뿐 미래 당첨 확률을 바꾸지 않습니다(1등 1/8,145,060 불변).",
        "algorithm_version": TICKET_ALGORITHM_VERSION,
        "engine_version": ENGINE_VERSION,
    }


def build_ticket_backtest(
    warmup: int = WARMUP,
    reps: int = RANDOM_REPS_DEFAULT,
    seed: int = RANDOM_SEED,
    draws: Optional[List[Draw]] = None,
) -> Dict[str, Any]:
    """6개 1장 단위 walk-forward 백테스트 + 무작위 기준선. `draws` 미지정 시 현재 이력(캐시)."""
    if draws is not None:
        return _ticket_compute(draws, warmup, reps, seed)
    draws = load_draws()
    sig = data_signature(draws)
    out = dict(cached("ticket_backtest", sig, (int(warmup), int(reps), int(seed)),
                      lambda: _ticket_compute(draws, warmup, reps, seed)))
    out["data_signature"] = sig
    return out
