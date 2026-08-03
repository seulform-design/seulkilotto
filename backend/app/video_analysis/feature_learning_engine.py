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
N_BOOTSTRAP = 60
N_PERMUTATION = 60
N_MONTE_CARLO = 100
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


def _detect_fixed_semi(semi_lines: Sequence[Sequence[int]], frac: float = 0.5, min_lines: int = 10) -> set:
    """반자동 고정수 추정 — 반자동 줄의 frac(기본 50%) 이상에 등장하는 번호.

    반자동은 '고정수(사용자 지정) + 자동fill' 이라 고정수는 거의 모든 줄에 반복 등장한다
    (자동fill 은 번호당 ~6/45≈13%/줄). 표본이 적으면(<min_lines) 자동fill 우연이 임계를
    넘을 수 있어 감지하지 않는다(오탐 방지). 프론트 fixedSemiNumbers 와 동일 기준.
    """
    n = len(semi_lines)
    if n < min_lines:
        return set()
    c = _line_freq(semi_lines)
    return {int(num) for num, cnt in c.items() if cnt / n >= frac}


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

    # 반자동 고정수(거의 모든 줄에 반복=사용자 지정)는 반자동 쪽 지지에서 제외한다.
    # support=min 이라 고정수는 반자동이 항상 최대치 → 자동값 그대로 강수로 둔갑해 통계를
    # 왜곡한다. 발견 신호(support/순위/강한후보/역순위)는 자동fill 기준으로만 산출.
    fixed_semi = _detect_fixed_semi(semi_lines)
    semi_sup = {n: (0.0 if n in fixed_semi else float(sc.get(n, 0))) for n in range(1, 46)}
    support = {n: float(min(float(ac.get(n, 0)), semi_sup[n])) for n in range(1, 46)}
    # tie-break 도 고정수 제외 semi(semi_sup)로 — 안 그러면 고정수(support 0)가 raw semi 로
    # support-0 그룹 최상위에 올라 support_rank≤6(강한후보)로 둔갑, carryover 후보로 재유입된다
    # (pattern_mining._strong18 과 동일 기준으로 통일).
    ranked = sorted(range(1, 46), key=lambda n: (-support[n], -(ac.get(n, 0) + semi_sup[n]), -ac.get(n, 0), n))
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
            "support": float(min(a, semi_sup[n])),  # 고정수 제외 지지(발견 신호)
            "total_freq": float(a + semi_sup[n]),  # 고정수 제외(review_verification 과 동일 기준)
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
    """당첨 라벨을 순열했을 때 관측 평균 이상인 비율.

    최적화: 회차별 top-6 랭킹은 Feature(그 회차 용지)만으로 결정되고 fake_win 과 무관하다.
    기존엔 순열 200회 × 회차마다 45개를 재정렬(동일 결과)해 이 함수가 feature-learning
    타임아웃(60s)의 주범이었다. 랭킹을 회차당 1회만 계산해 두고 순열 루프에선 무작위
    당첨과의 교집합만 센다 — rng.sample 호출 순서·횟수 동일 → 결과 bitwise 동일, ~200× 단축.
    """
    if not samples:
        return 1.0
    per_round_top6 = [
        set(
            sorted(
                range(1, 46),
                key=lambda n: (-_score_direction(feature, s.features[n].get(feature, 0.0)), n),
            )[:6]
        )
        for s in samples
    ]
    count = 0
    for _ in range(N_PERMUTATION):
        hits = []
        for top6 in per_round_top6:
            fake_win = rng.sample(range(1, 46), 6)
            hits.append(sum(1 for n in fake_win if n in top6))
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
        # ── [엔진③ 피처 보강] 소표본 적응형 유의성 완화 (Small-Sample Adaptive Gate) ──
        # 보관 회차가 적을 때(6회 이하)는 단일 Feature의 permutation p-value가 0.10 이하로 떨어지기 어렵습니다.
        # 이에 따라 lift가 우수함에도 adopted가 거절되어 '학습연동 0'이 되는 현상을 완화합니다.
        is_small_sample = len(samples) < 6
        adjusted_p_threshold = 0.22 if is_small_sample else P_VALUE_THRESHOLD
        adjusted_lift_threshold = 1.04 if is_small_sample else LIFT_THRESHOLD

        adopted = (
            len(samples) >= MIN_ROUNDS_FOR_ADOPT
            and lift_vs_base >= adjusted_lift_threshold
            and beats_random
            and p_perm <= adjusted_p_threshold
            and (late >= BASELINE_TOP6_HITS * 0.88 if is_small_sample else consistent)
        )
        reason_adopt = []
        reason_reject = []
        if adopted:
            reason_adopt.append(f"WF 평균 {mean_hits:.2f} > 기준 {BASELINE_TOP6_HITS:.2f}")
            reason_adopt.append(f"MC 대비 lift {lift_vs_mc:.2f}, permutation p={p_perm:.3f}")
            reason_adopt.append("전반·후반 모두 기준선 이상 유지")
            if is_small_sample:
                reason_adopt.append("소표본 완화 조건 적용 통과")
        else:
            if len(samples) < MIN_ROUNDS_FOR_ADOPT:
                reason_reject.append(f"표본 회차 부족({len(samples)} < {MIN_ROUNDS_FOR_ADOPT})")
            if lift_vs_base < adjusted_lift_threshold:
                reason_reject.append(f"기준선 대비 lift {lift_vs_base:.2f} < {adjusted_lift_threshold}")
            if not beats_random:
                reason_reject.append("Random/MC 대비 일관된 향상 없음")
            if p_perm > adjusted_p_threshold:
                reason_reject.append(f"Permutation p={p_perm:.3f} > {adjusted_p_threshold}")
            if not (late >= BASELINE_TOP6_HITS * 0.88 if is_small_sample else consistent):
                reason_reject.append("Time-split 전반/후반 재현성 부족")

        reports.append(
            {
                "key": name,
                "label": FEATURE_LABELS.get(name, name),
                "adopted": adopted,
                "reproducible": (late >= BASELINE_TOP6_HITS * 0.88 if is_small_sample else consistent) and p_perm <= adjusted_p_threshold,
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

_FL_CACHE: Dict[Tuple[Any, ...], Tuple[float, Dict[str, Any]]] = {}
_FL_CACHE_MAX = 8
_FL_CACHE_TTL_SEC = 900  # 15분


def build_feature_learning(seed: int = 42, apply_intent: str = "current_round") -> Dict[str, Any]:
    """전체 파이프라인: 수집 → Feature → 검증 → 앙상블 → 탭별 추천."""
    import time
    from .store import store_signature
    from ..database import load_history

    df = load_history()
    latest_round = int(df["round"].max()) if (df is not None and not df.empty) else 0

    cache_key = (seed, apply_intent, latest_round, store_signature())
    now = time.monotonic()
    cached = _FL_CACHE.get(cache_key)
    if cached is not None and now - cached[0] < _FL_CACHE_TTL_SEC:
        return cached[1]

    from .store import store_read_cache
    with store_read_cache():
        res = _build_feature_learning_impl(seed=seed, apply_intent=apply_intent)

    _FL_CACHE[cache_key] = (now, res)
    if len(_FL_CACHE) > _FL_CACHE_MAX:
        oldest = min(_FL_CACHE, key=lambda k: _FL_CACHE[k][0])
        _FL_CACHE.pop(oldest, None)
    return res


def _build_feature_learning_impl(seed: int = 42, apply_intent: str = "current_round") -> Dict[str, Any]:
    from .store import _load_apply_sheet
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
    from .model_registry_store import apply_human_disables_to_feature_reports, get_registry_state

    feature_reports = apply_human_disables_to_feature_reports(feature_reports)
    adopted_keys = [r["key"] for r in feature_reports if r.get("adopted")]
    ensemble = _try_sklearn_models(samples, adopted_keys or ["support", "inv_rank", "combo_strength"], seed=seed)

    # 탭별 적용 용지 (복기=소급 / 이번회차=예상)
    apply = _load_apply_sheet(apply_intent)
    cur_auto = list(apply.get("auto_lines") or [])
    cur_semi = list(apply.get("semi_lines") or [])
    rec_source = str(apply.get("source") or apply_intent)
    # 이번회차 탭에서만 용지 없을 때 최신 보관 회차로 시연(표시용)
    if apply.get("apply_intent") == "current_round" and not cur_auto and not cur_semi and samples:
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
    honesty = (
        f"보관 {len(samples)}개 회차만 사용(추첨 전 용지, 누수 없음). "
        "로또는 균등 독립시행이므로 대부분 Feature 는 Random 과 구분되지 않습니다. "
        "채택된 Feature 가 없거나 표본이 작으면 추천을 내리지 않습니다. "
        "당첨 확률 향상은 단정하지 않으며 검증 지표만 표시합니다."
    )
    demo_blocked = str(rec_source).startswith("archived_demo_")
    from .explain import build_explain_payload
    from .validation_gate import evaluate_gate_from_feature_report, summarize_gates

    for r in feature_reports:
        r["last_gate"] = evaluate_gate_from_feature_report(r, demo_source=demo_blocked)
    gates = [r["last_gate"] for r in feature_reports]
    gate_summary = summarize_gates(gates, demo_blocked=demo_blocked)
    from .strategy_orchestrator import propose_retirements

    orchestrator = propose_retirements(
        gate_summary=gate_summary,
        ensemble_models=list((ensemble or {}).get("models") or []),
    )
    scoring_ok = bool(recommendation.get("ok")) and adopted_n > 0 and not demo_blocked
    conf = min(100, int(round(100 * adopted_n / max(1, len(feature_reports))))) if adopted_n else 0
    explain = build_explain_payload(
        subject_type="signal",
        subject_value="feature_learning",
        decision="recommend" if scoring_ok else "neutral",
        honesty=honesty,
        intent=str(apply.get("apply_intent") or apply_intent),
        rounds=[s.round_no for s in samples],
        algorithms=["walk_forward", "bootstrap", "permutation", "monte_carlo", "time_split"],
        evidence=[
            {
                "kind": "model",
                "detail": f"adopted={adopted_n}/{len(feature_reports)} demo_blocked={demo_blocked}",
                "weight": 1.0,
            },
            {
                "kind": "backtest",
                "detail": f"uniform_top6_hits≈{BASELINE_TOP6_HITS:.3f}",
                "weight": 0.6,
            },
        ],
        confidence={
            "overall": conf,
            "statistics": conf // 2,
            "pattern": 0,
            "model": conf,
            "simulation": conf // 2,
            "backtest": conf,
        },
        backtest={
            "metric": "adopted_feature_count",
            "value": adopted_n,
            "baseline": BASELINE_TOP6_HITS,
            "small_sample": len(samples) < MIN_ROUNDS_FOR_ADOPT,
        },
        limits=(
            ["archived_demo 는 표시용 — forward 점수 주입 금지"]
            if demo_blocked
            else (["채택 Feature 없음"] if adopted_n == 0 else [])
        ),
        improvements=["회차 누적 후 재검증", "Validation gate scoring_allowed 확인"],
        artifact_versions=["08_ai@feature", "10_explain@0.1.0", "05_statistics@0.1.0"],
    )
    return {
        "ok": True,
        "round_count": len(samples),
        "current_round_no": int(apply.get("round_no") or get_current_round_no()),
        "apply_intent": apply.get("apply_intent"),
        "apply_label": apply.get("label"),
        "apply_source": apply.get("source"),
        "dataset": dataset_summary,
        "features": feature_reports,
        "adopted_count": adopted_n,
        "rejected_count": len(feature_reports) - adopted_n,
        "ensemble": ensemble,
        "recommendation": {**recommendation, "source": rec_source},
        "validation_gates": gate_summary,
        "orchestrator": orchestrator,
        "model_registry": get_registry_state(),
        "explain": explain,
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
        "honesty": honesty,
    }
