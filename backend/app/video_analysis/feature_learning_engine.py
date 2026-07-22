"""복기 용지 Feature 자동 생성·검증·학습 엔진.

보관된 과거 회차 용지(추첨 전 등록분)만으로 Feature Dataset 을 구축하고,
각 Feature 를 Walk-Forward / Bootstrap / Permutation / Monte Carlo /
Random Baseline 과 비교해 **재현 가능한 성능 향상**이 있을 때만 채택한다.

절대 규칙:
  - 미래(당첨) 정보를 Feature 에 넣지 않는다.
  - 검증 미통과 Feature 는 추천에 반영하지 않는다.
  - '당첨 확률이 향상되었다'고 단정하지 않는다. 지표만 보고한다.
"""
from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np

BASELINE_HIT = 6.0 / 45.0  # 임의 번호가 당첨 6개에 속할 확률
BASELINE_TOP6_HITS = 6.0 * BASELINE_HIT  # ≈ 0.8
N_BOOTSTRAP = 200
N_PERMUTATION = 200
N_MONTE_CARLO = 300
MIN_ROUNDS_FOR_ADOPT = 2
LIFT_THRESHOLD = 1.08  # Random 대비 일관 향상 하한(보수)
P_VALUE_THRESHOLD = 0.10  # 표본이 작아 완화, 그래도 우연 배제용


# ---------------------------------------------------------------------------
# Feature builders (번호×회차 단위, 당첨번호 미사용)
# ---------------------------------------------------------------------------

def _line_freq(lines: Sequence[Sequence[int]]) -> Counter:
    c: Counter = Counter()
    for ln in lines:
        for n in {int(x) for x in ln if 1 <= int(x) <= 45}:
            c[n] += 1
    return c


def _decade(n: int) -> int:
    return min(4, (n - 1) // 10)


def _ac_proxy(line: Sequence[int]) -> float:
    """줄 AC값 근사 — unique pairwise diffs / 조합 수."""
    nums = sorted({int(x) for x in line if 1 <= int(x) <= 45})
    if len(nums) < 2:
        return 0.0
    diffs = {nums[j] - nums[i] for i in range(len(nums)) for j in range(i + 1, len(nums))}
    return float(len(diffs) - (len(nums) - 1))


def _neighbor_count(n: int, freq: Counter) -> float:
    s = 0.0
    if n > 1:
        s += float(freq.get(n - 1, 0))
    if n < 45:
        s += float(freq.get(n + 1, 0))
    return s


def _end_digit(n: int) -> int:
    return n % 10


def build_number_features(
    auto_lines: List[List[int]],
    semi_lines: List[List[int]],
) -> Dict[int, Dict[str, float]]:
    """용지 줄만으로 번호별 Feature 벡터 생성(당첨번호 미사용)."""
    from .overlap_learning import combo_strength_by_number

    ac = _line_freq(auto_lines)
    sc = _line_freq(semi_lines)
    total_lines = max(1, len(auto_lines) + len(semi_lines))
    auto_n = max(1, len(auto_lines))
    semi_n = max(1, len(semi_lines))

    combo_auto = combo_strength_by_number(auto_lines, "fl-a") if len(auto_lines) >= 2 else {n: 0.0 for n in range(1, 46)}
    combo_semi = combo_strength_by_number(semi_lines, "fl-s") if len(semi_lines) >= 2 else {n: 0.0 for n in range(1, 46)}
    combo_all = combo_strength_by_number(auto_lines + semi_lines, "fl-t") if (len(auto_lines) + len(semi_lines)) >= 2 else {
        n: 0.0 for n in range(1, 46)
    }

    # 줄별 구조 통계 → 번호가 속한 줄의 평균
    line_sum: Dict[int, List[float]] = {n: [] for n in range(1, 46)}
    line_odd: Dict[int, List[float]] = {n: [] for n in range(1, 46)}
    line_ac: Dict[int, List[float]] = {n: [] for n in range(1, 46)}
    line_span: Dict[int, List[float]] = {n: [] for n in range(1, 46)}
    line_consec: Dict[int, List[float]] = {n: [] for n in range(1, 46)}
    for ln in auto_lines + semi_lines:
        nums = sorted({int(x) for x in ln if 1 <= int(x) <= 45})
        if len(nums) != 6:
            continue
        s = float(sum(nums))
        odd = float(sum(1 for x in nums if x % 2 == 1))
        acv = _ac_proxy(nums)
        span = float(nums[-1] - nums[0])
        consec = 0.0
        for i in range(1, len(nums)):
            if nums[i] == nums[i - 1] + 1:
                consec += 1.0
        for n in nums:
            line_sum[n].append(s)
            line_odd[n].append(odd)
            line_ac[n].append(acv)
            line_span[n].append(span)
            line_consec[n].append(consec)

    support = {n: float(min(ac.get(n, 0), sc.get(n, 0))) for n in range(1, 46)}
    ranked = sorted(range(1, 46), key=lambda n: (-support[n], -(ac.get(n, 0) + sc.get(n, 0)), -ac.get(n, 0), n))
    rank_of = {n: i + 1 for i, n in enumerate(ranked)}

    # 그룹(같은 decade 내 등장 밀도)
    decade_freq = Counter()
    for n in range(1, 46):
        if ac.get(n, 0) + sc.get(n, 0) > 0:
            decade_freq[_decade(n)] += ac.get(n, 0) + sc.get(n, 0)

    # 이웃수 밀도용 합산 빈도 — 루프 밖에서 한 번만 만든다(과거엔 45개 번호마다
    # 45항 Counter 를 재생성해 O(45²) 였음).
    combined_freq = Counter({k: ac.get(k, 0) + sc.get(k, 0) for k in range(1, 46)})

    out: Dict[int, Dict[str, float]] = {}
    for n in range(1, 46):
        a = float(ac.get(n, 0))
        s = float(sc.get(n, 0))
        tot = a + s
        r = float(rank_of[n])
        ls = line_sum[n]
        out[n] = {
            "auto_count": a,
            "semi_count": s,
            "support": float(min(a, s)),
            "total_freq": tot,
            "auto_rate": a / auto_n,
            "semi_rate": s / semi_n,
            "inclusion_rate": tot / total_lines,
            "support_rank": r,
            "strong_candidate": 1.0 if r <= 6 else 0.0,
            "weak_candidate": 1.0 if r >= 31 else 0.0,
            "auto_axis": 1.0 if a > 0 else 0.0,
            "semi_axis": 1.0 if s > 0 else 0.0,
            "both_axis": 1.0 if a > 0 and s > 0 else 0.0,
            "combo_strength_auto": float(combo_auto.get(n, 0.0)),
            "combo_strength_semi": float(combo_semi.get(n, 0.0)),
            "combo_strength": float(combo_all.get(n, 0.0)),
            "decade": float(_decade(n)),
            "odd": 1.0 if n % 2 else 0.0,
            "high_low": 1.0 if n >= 23 else 0.0,
            "end_digit": float(_end_digit(n)),
            "neighbor_density": _neighbor_count(n, combined_freq),
            "decade_group_size": float(decade_freq.get(_decade(n), 0)),
            "avg_line_sum": float(np.mean(ls)) if ls else 0.0,
            "avg_line_odd": float(np.mean(line_odd[n])) if line_odd[n] else 0.0,
            "avg_line_ac": float(np.mean(line_ac[n])) if line_ac[n] else 0.0,
            "avg_line_span": float(np.mean(line_span[n])) if line_span[n] else 0.0,
            "avg_line_consec": float(np.mean(line_consec[n])) if line_consec[n] else 0.0,
            "number_density": (6.0 / max(1.0, float(np.mean(line_span[n])))) if line_span[n] else 0.0,
            "inv_rank": 46.0 - r,
        }
    return out


FEATURE_LABELS: Dict[str, str] = {
    "auto_count": "자동축 등장 줄수",
    "semi_count": "반자동축 등장 줄수",
    "support": "강한후보(양쪽지지)",
    "total_freq": "전체 출현빈도",
    "auto_rate": "자동 포함률",
    "semi_rate": "반자동 포함률",
    "inclusion_rate": "용지 포함률",
    "support_rank": "지지 순위(낮을수록 강함)",
    "strong_candidate": "강한후보 여부(상위6)",
    "weak_candidate": "약한후보 여부(하위15)",
    "auto_axis": "자동축 포함 여부",
    "semi_axis": "반자동축 포함 여부",
    "both_axis": "자동·반자동 동시",
    "combo_strength_auto": "자동 조합강도",
    "combo_strength_semi": "반자동 조합강도",
    "combo_strength": "그룹·매치 조합강도",
    "decade": "번호구간(decade)",
    "odd": "홀짝",
    "high_low": "고저",
    "end_digit": "끝수",
    "neighbor_density": "이웃수 밀도",
    "decade_group_size": "그룹 크기(구간)",
    "avg_line_sum": "소속줄 합계 평균",
    "avg_line_odd": "소속줄 홀수 평균",
    "avg_line_ac": "소속줄 AC값 평균",
    "avg_line_span": "번호간 거리(span)",
    "avg_line_consec": "연속수",
    "number_density": "번호 밀도",
    "inv_rank": "지지 역순위 점수",
}

# support_rank 는 낮을수록 강함 → 점수화 시 방향 반전
INVERT_FEATURES = {"support_rank"}


# ---------------------------------------------------------------------------
# Dataset collection
# ---------------------------------------------------------------------------

@dataclass
class RoundSample:
    round_no: int
    auto_lines: List[List[int]]
    semi_lines: List[List[int]]
    winning: List[int]
    features: Dict[int, Dict[str, float]]


def _winning_by_round() -> Dict[int, List[int]]:
    from ..database import load_history

    df = load_history()
    out: Dict[int, List[int]] = {}
    if df is None or getattr(df, "empty", True):
        return out
    for _, row in df.iterrows():
        try:
            out[int(row["round"])] = [int(row[f"num{i}"]) for i in range(1, 7)]
        except Exception:  # noqa: BLE001
            continue
    return out


def collect_round_samples() -> List[RoundSample]:
    """누수 없는 보관 배치만 수집."""
    from .store import _load_historical_raw, _manual_saved_lines

    historical = _load_historical_raw()
    batches = historical.get("archived_current_rounds") or []
    win_map = _winning_by_round()
    samples: List[RoundSample] = []
    for batch in batches:
        rnd = batch.get("round_no")
        if rnd is None:
            continue
        rnd = int(rnd)
        winning = win_map.get(rnd)
        if not winning:
            continue
        entries = list(batch.get("entries") or [])
        auto = _manual_saved_lines(entries, "자동", include_photo=True)
        semi = _manual_saved_lines(entries, "반자동", include_photo=True)
        if not auto and not semi:
            continue
        feats = build_number_features(auto, semi)
        samples.append(
            RoundSample(
                round_no=rnd,
                auto_lines=auto,
                semi_lines=semi,
                winning=list(winning),
                features=feats,
            )
        )
    samples.sort(key=lambda s: s.round_no)
    return samples


# ---------------------------------------------------------------------------
# Univariate feature validation
# ---------------------------------------------------------------------------

def _score_direction(name: str, value: float) -> float:
    if name in INVERT_FEATURES:
        return -value
    return value


def _top6_hits_for_feature(sample: RoundSample, feature: str) -> int:
    ranked = sorted(
        range(1, 46),
        key=lambda n: (-_score_direction(feature, sample.features[n].get(feature, 0.0)), n),
    )
    win = set(sample.winning)
    return sum(1 for n in ranked[:6] if n in win)


def _walk_forward_feature_hits(samples: List[RoundSample], feature: str) -> List[float]:
    """각 회차에서 해당 Feature top-6 적중 수 (누수 없음: Feature 는 그 회차 용지만 사용)."""
    return [float(_top6_hits_for_feature(s, feature)) for s in samples]


def _bootstrap_mean_ci(values: List[float], rng: random.Random, n: int = N_BOOTSTRAP) -> Tuple[float, float, float]:
    if not values:
        return 0.0, 0.0, 0.0
    arr = np.array(values, dtype=float)
    means = []
    for _ in range(n):
        idx = [rng.randrange(len(arr)) for _ in range(len(arr))]
        means.append(float(arr[idx].mean()))
    means.sort()
    lo = means[int(0.025 * (n - 1))]
    hi = means[int(0.975 * (n - 1))]
    return float(arr.mean()), lo, hi


def _permutation_pvalue(observed: float, samples: List[RoundSample], feature: str, rng: random.Random) -> float:
    """당첨 라벨을 순열했을 때 관측 평균 이상인 비율."""
    if not samples:
        return 1.0
    count = 0
    for _ in range(N_PERMUTATION):
        hits = []
        for s in samples:
            fake_win = rng.sample(range(1, 46), 6)
            ranked = sorted(
                range(1, 46),
                key=lambda n: (-_score_direction(feature, s.features[n].get(feature, 0.0)), n),
            )
            hits.append(sum(1 for n in ranked[:6] if n in fake_win))
        if float(np.mean(hits)) >= observed - 1e-12:
            count += 1
    return (count + 1) / (N_PERMUTATION + 1)


def _monte_carlo_random_hits(n_rounds: int, rng: random.Random) -> Tuple[float, float, float]:
    """균등 무작위 top-6 vs 당첨6 적중 분포."""
    hits = []
    for _ in range(N_MONTE_CARLO):
        total = 0
        for _r in range(max(1, n_rounds)):
            pick = set(rng.sample(range(1, 46), 6))
            win = set(rng.sample(range(1, 46), 6))
            total += len(pick & win)
        hits.append(total / max(1, n_rounds))
    hits.sort()
    return float(np.mean(hits)), hits[int(0.025 * (len(hits) - 1))], hits[int(0.975 * (len(hits) - 1))]


def validate_features(samples: List[RoundSample], seed: int = 42) -> List[Dict[str, Any]]:
    if not samples:
        return []
    rng = random.Random(seed)
    feature_names = list(FEATURE_LABELS.keys())
    mc_mean, mc_lo, mc_hi = _monte_carlo_random_hits(len(samples), rng)

    reports: List[Dict[str, Any]] = []
    for name in feature_names:
        hits = _walk_forward_feature_hits(samples, name)
        mean_hits = float(np.mean(hits)) if hits else 0.0
        boot_mean, boot_lo, boot_hi = _bootstrap_mean_ci(hits, rng)
        p_perm = _permutation_pvalue(mean_hits, samples, name, rng)
        # Time split: 전반 학습 방향 확인용 — 후반 평균
        mid = max(1, len(hits) // 2)
        early = float(np.mean(hits[:mid])) if hits else 0.0
        late = float(np.mean(hits[mid:])) if len(hits) > mid else early
        lift_vs_base = mean_hits / BASELINE_TOP6_HITS if BASELINE_TOP6_HITS else 0.0
        lift_vs_mc = mean_hits / mc_mean if mc_mean else 0.0
        consistent = late >= BASELINE_TOP6_HITS * LIFT_THRESHOLD and early >= BASELINE_TOP6_HITS * 0.95
        beats_random = mean_hits >= mc_mean * LIFT_THRESHOLD and boot_lo > BASELINE_TOP6_HITS * 0.9
        adopted = (
            len(samples) >= MIN_ROUNDS_FOR_ADOPT
            and lift_vs_base >= LIFT_THRESHOLD
            and beats_random
            and p_perm <= P_VALUE_THRESHOLD
            and consistent
        )
        reason_adopt = []
        reason_reject = []
        if adopted:
            reason_adopt.append(f"WF 평균 {mean_hits:.2f} > 기준 {BASELINE_TOP6_HITS:.2f}")
            reason_adopt.append(f"MC 대비 lift {lift_vs_mc:.2f}, permutation p={p_perm:.3f}")
            reason_adopt.append("전반·후반 모두 기준선 이상 유지")
        else:
            if len(samples) < MIN_ROUNDS_FOR_ADOPT:
                reason_reject.append(f"표본 회차 부족({len(samples)} < {MIN_ROUNDS_FOR_ADOPT})")
            if lift_vs_base < LIFT_THRESHOLD:
                reason_reject.append(f"기준선 대비 lift {lift_vs_base:.2f} < {LIFT_THRESHOLD}")
            if not beats_random:
                reason_reject.append("Random/MC 대비 일관된 향상 없음")
            if p_perm > P_VALUE_THRESHOLD:
                reason_reject.append(f"Permutation p={p_perm:.3f} > {P_VALUE_THRESHOLD}")
            if not consistent:
                reason_reject.append("Time-split 전반/후반 재현성 부족")

        reports.append(
            {
                "key": name,
                "label": FEATURE_LABELS.get(name, name),
                "adopted": adopted,
                "reproducible": consistent and p_perm <= P_VALUE_THRESHOLD,
                "walk_forward_mean_hits": round(mean_hits, 4),
                "walk_forward_hits": [round(h, 3) for h in hits],
                "bootstrap_mean": round(boot_mean, 4),
                "bootstrap_ci95": [round(boot_lo, 4), round(boot_hi, 4)],
                "permutation_p": round(p_perm, 4),
                "monte_carlo_baseline": {
                    "mean": round(mc_mean, 4),
                    "ci95": [round(mc_lo, 4), round(mc_hi, 4)],
                },
                "uniform_baseline": round(BASELINE_TOP6_HITS, 4),
                "lift_vs_uniform": round(lift_vs_base, 3),
                "lift_vs_monte_carlo": round(lift_vs_mc, 3),
                "time_split": {"early_mean": round(early, 4), "late_mean": round(late, 4)},
                "validation_passed": adopted,
                "use_reason": reason_adopt,
                "exclude_reason": reason_reject,
            }
        )
    reports.sort(key=lambda r: (-int(r["adopted"]), -r["lift_vs_uniform"], r["permutation_p"]))
    return reports


# ---------------------------------------------------------------------------
# Ensemble (optional sklearn)
# ---------------------------------------------------------------------------

def _try_sklearn_models(
    samples: List[RoundSample],
    adopted_keys: List[str],
    seed: int = 42,
) -> Dict[str, Any]:
    if len(samples) < 2 or not adopted_keys:
        return {
            "ok": False,
            "reason": "채택 Feature 또는 표본 부족 — 앙상블 생략",
            "models": [],
            "selected": None,
        }
    try:
        from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier, VotingClassifier
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError:
        return {
            "ok": False,
            "reason": "scikit-learn 미설치 — 규칙 기반 Feature 점수만 사용",
            "models": [],
            "selected": None,
        }

    def matrix(samp_list: List[RoundSample]) -> Tuple[np.ndarray, np.ndarray]:
        xs, ys = [], []
        for s in samp_list:
            win = set(s.winning)
            for n in range(1, 46):
                xs.append([float(s.features[n].get(k, 0.0)) for k in adopted_keys])
                ys.append(1 if n in win else 0)
        return np.asarray(xs, dtype=float), np.asarray(ys, dtype=int)

    model_specs: List[Tuple[str, Any]] = [
        ("LogisticRegression", Pipeline([
            ("sc", StandardScaler()),
            ("clf", LogisticRegression(max_iter=400, class_weight="balanced", random_state=seed)),
        ])),
        ("RandomForest", RandomForestClassifier(
            n_estimators=80, max_depth=4, class_weight="balanced_subsample", random_state=seed, n_jobs=1,
        )),
        ("ExtraTrees", ExtraTreesClassifier(
            n_estimators=80, max_depth=4, class_weight="balanced_subsample", random_state=seed, n_jobs=1,
        )),
    ]

    # Optional boosters
    try:
        from xgboost import XGBClassifier  # type: ignore

        model_specs.append((
            "XGBoost",
            XGBClassifier(
                n_estimators=60, max_depth=3, learning_rate=0.08,
                objective="binary:logistic", eval_metric="logloss",
                random_state=seed, n_jobs=1, verbosity=0,
            ),
        ))
    except ImportError:
        pass
    try:
        from lightgbm import LGBMClassifier  # type: ignore

        model_specs.append((
            "LightGBM",
            LGBMClassifier(
                n_estimators=60, max_depth=3, learning_rate=0.08,
                class_weight="balanced", random_state=seed, verbosity=-1, n_jobs=1,
            ),
        ))
    except ImportError:
        pass
    try:
        from catboost import CatBoostClassifier  # type: ignore

        model_specs.append((
            "CatBoost",
            CatBoostClassifier(
                iterations=80, depth=3, learning_rate=0.08,
                loss_function="Logloss", verbose=False, random_seed=seed,
                auto_class_weights="Balanced",
            ),
        ))
    except ImportError:
        pass

    results: List[Dict[str, Any]] = []
    # Walk-forward: train on past rounds, score next
    for name, model in model_specs:
        wf_hits: List[float] = []
        importances: Dict[str, float] = {k: 0.0 for k in adopted_keys}
        folds = 0
        # 학습 회차가 1개뿐인 fold(i=1: 45행·양성6)는 퇴화 표본이라 건너뛴다 —
        # 최소 2개 회차로 학습해야 walk-forward 가 의미 있다.
        for i in range(2, len(samples)):
            train_s = samples[:i]
            test_s = samples[i]
            Xtr, ytr = matrix(train_s)
            if len(np.unique(ytr)) < 2:
                continue
            try:
                from sklearn.base import clone

                clf = clone(model)
                clf.fit(Xtr, ytr)
            except Exception:  # noqa: BLE001
                continue
            Xte = np.asarray(
                [[float(test_s.features[n].get(k, 0.0)) for k in adopted_keys] for n in range(1, 46)],
                dtype=float,
            )
            try:
                if hasattr(clf, "predict_proba"):
                    proba = clf.predict_proba(Xte)[:, 1]
                else:
                    proba = clf.decision_function(Xte)
            except Exception:  # noqa: BLE001
                continue
            ranked = sorted(range(1, 46), key=lambda n: (-float(proba[n - 1]), n))
            win = set(test_s.winning)
            wf_hits.append(float(sum(1 for n in ranked[:6] if n in win)))
            folds += 1
            # Permutation importance (lightweight)
            base = float(np.mean(wf_hits[-1:]))
            rng = np.random.RandomState(seed + i)
            for fi, key in enumerate(adopted_keys):
                Xperm = Xte.copy()
                rng.shuffle(Xperm[:, fi])
                try:
                    if hasattr(clf, "predict_proba"):
                        p2 = clf.predict_proba(Xperm)[:, 1]
                    else:
                        p2 = clf.decision_function(Xperm)
                    ranked2 = sorted(range(1, 46), key=lambda n: (-float(p2[n - 1]), n))
                    h2 = float(sum(1 for n in ranked2[:6] if n in win))
                    importances[key] += max(0.0, base - h2)
                except Exception:  # noqa: BLE001
                    pass

        mean_h = float(np.mean(wf_hits)) if wf_hits else 0.0
        results.append(
            {
                "name": name,
                "walk_forward_mean_hits": round(mean_h, 4),
                "walk_forward_hits": [round(h, 3) for h in wf_hits],
                "folds": folds,
                "lift_vs_uniform": round(mean_h / BASELINE_TOP6_HITS, 3) if wf_hits else 0.0,
                "permutation_importance": {
                    k: round(v / max(1, folds), 4) for k, v in sorted(importances.items(), key=lambda x: -x[1])
                },
                "stable": folds >= 1 and mean_h >= BASELINE_TOP6_HITS,
            }
        )

    # Voting on last fold if ≥2 models (학습 회차 ≥2 확보 위해 표본 ≥3 요구)
    if len(model_specs) >= 2 and len(samples) >= 3:
        try:
            from sklearn.base import clone

            estimators = [(n, clone(m)) for n, m in model_specs[:3]]
            voting = VotingClassifier(estimators=estimators, voting="soft")
            Xtr, ytr = matrix(samples[:-1])
            if len(np.unique(ytr)) >= 2:
                voting.fit(Xtr, ytr)
                test_s = samples[-1]
                Xte = np.asarray(
                    [[float(test_s.features[n].get(k, 0.0)) for k in adopted_keys] for n in range(1, 46)],
                    dtype=float,
                )
                proba = voting.predict_proba(Xte)[:, 1]
                ranked = sorted(range(1, 46), key=lambda n: (-float(proba[n - 1]), n))
                h = float(sum(1 for n in ranked[:6] if n in set(test_s.winning)))
                results.append(
                    {
                        "name": "Voting",
                        "walk_forward_mean_hits": round(h, 4),
                        "walk_forward_hits": [round(h, 3)],
                        "folds": 1,
                        "lift_vs_uniform": round(h / BASELINE_TOP6_HITS, 3),
                        "permutation_importance": {},
                        "stable": h >= BASELINE_TOP6_HITS,
                    }
                )
        except Exception:  # noqa: BLE001
            pass

    results.sort(key=lambda r: (-r["walk_forward_mean_hits"], -r["folds"]))
    selected = None
    for r in results:
        if r["stable"] and r["lift_vs_uniform"] >= LIFT_THRESHOLD:
            selected = r["name"]
            break
    if selected is None and results:
        # 가장 안정적(기준선 이상·분산 낮은) 모델만 참고용 유지 — 추천 강제 반영은 안 함
        selected = results[0]["name"] if results[0]["stable"] else None

    return {
        "ok": True,
        "models": results,
        "selected": selected,
        "note": (
            "검증 통과·기준선 초과 모델만 selected. "
            "XGBoost/LightGBM/CatBoost 는 설치된 경우에만 실험."
        ),
    }


# ---------------------------------------------------------------------------
# Recommendation with contributions (adopted features only)
# ---------------------------------------------------------------------------

def recommend_with_contributions(
    auto_lines: List[List[int]],
    semi_lines: List[List[int]],
    feature_reports: List[Dict[str, Any]],
    top_k: int = 15,
) -> Dict[str, Any]:
    adopted = [r for r in feature_reports if r.get("adopted")]
    if not auto_lines and not semi_lines:
        return {
            "ok": False,
            "reason": "이번회차/대상 용지 줄이 없습니다.",
            "numbers": [],
            "adopted_feature_count": len(adopted),
        }
    if not adopted:
        return {
            "ok": False,
            "reason": "검증을 통과한 Feature 가 없어 추천에 반영하지 않습니다.",
            "numbers": [],
            "adopted_feature_count": 0,
            "honesty": "검증 미통과 Feature 는 자동 제외됩니다.",
        }

    feats = build_number_features(auto_lines, semi_lines)
    # 가중치 = lift_vs_uniform × (1 - p) 재현성
    weights = {
        r["key"]: max(0.0, float(r["lift_vs_uniform"]) - 1.0) * max(0.0, 1.0 - float(r["permutation_p"]))
        for r in adopted
    }
    # 정규화
    wsum = sum(weights.values()) or 1.0
    weights = {k: v / wsum for k, v in weights.items()}

    # Feature 표준화용
    vals_by_f: Dict[str, List[float]] = {k: [] for k in weights}
    for n in range(1, 46):
        for k in weights:
            vals_by_f[k].append(_score_direction(k, feats[n].get(k, 0.0)))
    mean_std = {
        k: (float(np.mean(v)), float(np.std(v) or 1.0))
        for k, v in vals_by_f.items()
    }

    scored: List[Dict[str, Any]] = []
    for n in range(1, 46):
        contribs = []
        total = 0.0
        for k, w in weights.items():
            raw = _score_direction(k, feats[n].get(k, 0.0))
            mu, sd = mean_std[k]
            z = (raw - mu) / sd
            c = w * z
            total += c
            if abs(c) > 1e-6:
                contribs.append(
                    {
                        "feature": k,
                        "label": FEATURE_LABELS.get(k, k),
                        "contribution": round(float(c), 4),
                        "raw_value": round(float(feats[n].get(k, 0.0)), 4),
                        "weight": round(float(w), 4),
                    }
                )
        contribs.sort(key=lambda x: -abs(x["contribution"]))
        scored.append(
            {
                "number": n,
                "score": round(float(total), 4),
                "contributions": contribs[:8],
            }
        )
    scored.sort(key=lambda x: (-x["score"], x["number"]))
    top = scored[:top_k]
    return {
        "ok": True,
        "adopted_feature_count": len(adopted),
        "adopted_features": [{"key": r["key"], "label": r["label"], "lift": r["lift_vs_uniform"]} for r in adopted],
        "numbers": top,
        "top6": [x["number"] for x in top[:6]],
        "honesty": (
            "검증 통과 Feature 의 상대 점수·기여도만 표시합니다. "
            "당첨 확률 향상을 단정하지 않으며, Random 대비 지표를 함께 확인하세요."
        ),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_feature_learning(seed: int = 42) -> Dict[str, Any]:
    """전체 파이프라인: 수집 → Feature → 검증 → 앙상블 → 이번회차 추천."""
    from .store import _load_current_raw, _manual_saved_lines
    from .draw_template import get_current_round_no

    samples = collect_round_samples()
    if not samples:
        return {
            "ok": False,
            "reason": (
                "보관된 과거 회차 용지가 없습니다. "
                "이번회차 용지를 등록하면 추첨 후 자동 보관되어 Feature 학습에 사용됩니다."
            ),
            "round_count": 0,
            "features": [],
            "ensemble": {"ok": False, "models": [], "selected": None},
            "recommendation": {"ok": False, "numbers": []},
        }

    feature_reports = validate_features(samples, seed=seed)
    adopted_keys = [r["key"] for r in feature_reports if r.get("adopted")]
    ensemble = _try_sklearn_models(samples, adopted_keys or ["support", "inv_rank", "combo_strength"], seed=seed)

    # 이번회차 용지
    current = _load_current_raw()
    cur_entries = list(current.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동", include_photo=True)
    cur_semi = _manual_saved_lines(cur_entries, "반자동", include_photo=True)
    # 이번회차 없으면 최신 보관 회차로 시연(표시용, 추천 라벨에 명시)
    rec_source = "current_round"
    if not cur_auto and not cur_semi and samples:
        last = samples[-1]
        cur_auto, cur_semi = last.auto_lines, last.semi_lines
        rec_source = f"archived_demo_{last.round_no}"

    recommendation = recommend_with_contributions(cur_auto, cur_semi, feature_reports)

    dataset_summary = {
        "rounds": [
            {
                "round_no": s.round_no,
                "auto_lines": len(s.auto_lines),
                "semi_lines": len(s.semi_lines),
                "winning": s.winning,
            }
            for s in samples
        ],
        "feature_count": len(FEATURE_LABELS),
        "sample_rows": len(samples) * 45,
        "sources": ["archived_current_rounds"],
        "excluded_sources": ["review_saved(사후복기 — 학습 제외, 누수 방지)"],
    }

    adopted_n = sum(1 for r in feature_reports if r["adopted"])
    return {
        "ok": True,
        "round_count": len(samples),
        "current_round_no": int(get_current_round_no()),
        "dataset": dataset_summary,
        "features": feature_reports,
        "adopted_count": adopted_n,
        "rejected_count": len(feature_reports) - adopted_n,
        "ensemble": ensemble,
        "recommendation": {**recommendation, "source": rec_source},
        "baselines": {
            "uniform_top6_hits": round(BASELINE_TOP6_HITS, 4),
            "uniform_hit_rate": round(BASELINE_HIT, 4),
        },
        "pipeline": [
            "복기(보관) 데이터 수집",
            "Feature 자동 생성",
            "Walk-Forward / Bootstrap / Permutation / Monte Carlo / Time-Split 검증",
            "Random Baseline 비교",
            "Feature Importance(Permutation)",
            "앙상블 실험",
            "검증 통과 Feature 만 추천·기여도 출력",
        ],
        "honesty": (
            f"보관 {len(samples)}개 회차만 사용(추첨 전 용지, 누수 없음). "
            "로또는 균등 독립시행이므로 대부분 Feature 는 Random 과 구분되지 않습니다. "
            "채택된 Feature 가 없거나 표본이 작으면 추천을 내리지 않습니다. "
            "당첨 확률 향상은 단정하지 않으며 검증 지표만 표시합니다."
        ),
    }
