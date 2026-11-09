"""핵심 통계/분석 알고리즘 (Pandas + NumPy).

모든 함수는 순수 함수(side-effect 없음)로 설계되어 단위 테스트가 용이하다.
입력은 database.load_history() 가 만든 표준 DataFrame 을 사용한다.
"""
from __future__ import annotations

from typing import Dict, List, Set, Tuple, Optional
import numpy as np
import pandas as pd
from scipy.stats import hypergeom

from .database import NUMBER_COLUMNS


ALL_NUMBERS = list(range(1, 46))  # 로또 전체 번호 풀


# =============================================================================
# 1) 번호별 출현 빈도 분석
# =============================================================================
def calc_frequency(df: pd.DataFrame, recent_n: int | None = None) -> Dict:
    """1~45번 번호별 출현 빈도수 및 비율을 계산한다.

    Args:
        df: 전체 회차 DataFrame (round 오름차순).
        recent_n: 최근 N회차만 집계. None 이면 전체.

    Returns:
        {"total_rounds": int, "items": [{number, count, ratio}, ...]}
    """
    # 최근 N회차 슬라이싱 (round 기준 내림차순 상위 N개)
    target = df.sort_values("round", ascending=False).head(recent_n) if recent_n else df
    total_rounds = len(target)

    # 6개 번호 컬럼을 1차원으로 펼친 뒤 value_counts 로 빈도 집계 (벡터 연산)
    flat = target[NUMBER_COLUMNS].to_numpy().ravel()
    counts = pd.Series(flat).value_counts()

    items: List[Dict] = []
    for n in ALL_NUMBERS:
        c = int(counts.get(n, 0))
        # 비율 = 해당 번호 출현 수 / 전체 추첨 회차 수 (한 회차당 한 번 출현 가능 기준)
        ratio = round(c / total_rounds, 4) if total_rounds else 0.0
        items.append({"number": n, "count": c, "ratio": ratio})

    # 빈도 내림차순 정렬하여 "핫 넘버"가 상단에 오도록 함
    items.sort(key=lambda x: x["count"], reverse=True)
    return {"total_rounds": total_rounds, "items": items}


# =============================================================================
# 2) 사용자 조합 분석 (홀짝/총합/연속번호)
# =============================================================================
def analyze_combination(numbers: List[int]) -> Dict:
    """6개 번호 조합의 홀짝 비율, 총합 구간, 연속 번호 여부를 분석한다."""
    nums = sorted(numbers)

    odd_count = sum(1 for n in nums if n % 2 == 1)
    even_count = len(nums) - odd_count
    sum_total = int(sum(nums))

    # 총합 구간 분류: 6개 번호 합의 통계적 중앙(약 100~170)을 기준으로 구간화
    if sum_total < 100:
        sum_band = "낮음"
    elif sum_total <= 170:
        sum_band = "보통"
    else:
        sum_band = "높음"

    # 연속 번호(예: 11,12) 탐지
    consecutive_pairs: List[List[int]] = []
    for i in range(len(nums) - 1):
        if nums[i + 1] - nums[i] == 1:
            consecutive_pairs.append([nums[i], nums[i + 1]])

    return {
        "numbers": nums,
        "odd_count": odd_count,
        "even_count": even_count,
        "sum_total": sum_total,
        "sum_band": sum_band,
        "has_consecutive": len(consecutive_pairs) > 0,
        "consecutive_pairs": consecutive_pairs,
    }


# =============================================================================
# 3) 가중치 기반 번호 조합 생성
# =============================================================================
def find_unseen_numbers(df: pd.DataFrame, lookback: int = 5) -> List[int]:
    """최근 `lookback` 회차 동안 한 번도 출현하지 않은 번호 목록 반환."""
    recent = df.sort_values("round", ascending=False).head(lookback)
    seen = set(recent[NUMBER_COLUMNS].to_numpy().ravel().tolist())
    return [n for n in ALL_NUMBERS if n not in seen]


def build_weights(
    df: pd.DataFrame,
    unseen_bonus: float = 0.15,
    lookback: int = 5,
) -> np.ndarray:
    """각 번호(1~45)의 선택 가중치 배열을 생성한다.

    가중치 = (전체 기간 출현 빈도 기반 base 확률)
             × (미출현 번호면 1 + unseen_bonus)

    - base: 자주 나온 번호일수록 약간 높은 기본 가중치(빈도 기반).
    - 미출현 보너스: 요구사항대로 최근 N회 미출현 번호에 +15% 가산.
    """
    flat = df[NUMBER_COLUMNS].to_numpy().ravel()
    counts = pd.Series(flat).value_counts()

    # 1~45 순서의 기본 빈도 벡터 (0 방지를 위해 +1 라플라스 스무딩)
    base = np.array([counts.get(n, 0) + 1 for n in ALL_NUMBERS], dtype=float)
    base = base / base.sum()

    unseen = set(find_unseen_numbers(df, lookback))
    multiplier = np.array(
        [(1 + unseen_bonus) if n in unseen else 1.0 for n in ALL_NUMBERS],
        dtype=float,
    )

    weights = base * multiplier
    return weights / weights.sum()  # 정규화하여 확률분포로 변환


def generate_weighted_sets(
    df: pd.DataFrame,
    n_sets: int = 6,
    unseen_bonus: float = 0.15,
    lookback: int = 5,
    exclude_consecutive: bool = False,
    seed: int | None = None,
) -> Dict:
    """가중치 기반 추천 번호 조합을 n_sets 개 생성한다.

    Args:
        n_sets: 생성할 조합 수.
        exclude_consecutive: True 면 연속 번호가 포함된 조합을 재추첨.
        seed: 재현성을 위한 시드.
    """
    rng = np.random.default_rng(seed)
    weights = build_weights(df, unseen_bonus, lookback)
    unseen = find_unseen_numbers(df, lookback)

    combinations: List[Dict] = []
    attempts = 0
    max_attempts = n_sets * 50  # 무한 루프 방지

    while len(combinations) < n_sets and attempts < max_attempts:
        attempts += 1
        # 가중치 기반 비복원 추출로 6개 번호 선택
        picked = rng.choice(ALL_NUMBERS, size=6, replace=False, p=weights)
        nums = sorted(int(x) for x in picked)

        if exclude_consecutive:
            if any(nums[i + 1] - nums[i] == 1 for i in range(5)):
                continue  # 연속 번호 포함 시 폐기 후 재추첨

        combinations.append(
            {
                "numbers": nums,
                "sum_total": int(sum(nums)),
                "odd_count": sum(1 for n in nums if n % 2 == 1),
                "even_count": sum(1 for n in nums if n % 2 == 0),
            }
        )

    result: Dict = {"unseen_numbers": unseen, "combinations": combinations}
    if len(combinations) < n_sets:
        result["warning"] = (
            f"요청 {n_sets}조합 중 {len(combinations)}조합만 생성됐습니다. "
            f"연속번호 제외 등 조건을 완화해 보세요."
        )
    return result


# =============================================================================
# 4) 스마트 조합 — 다양화·역사적 필터·인기 패턴 회피
# =============================================================================
SUM_MIN, SUM_MAX = 100, 175
VALID_ODD = {2, 3, 4}
MAX_SMART_ATTEMPTS = 8000


def _combo_dict(nums: List[int]) -> Dict:
    return {
        "numbers": nums,
        "sum_total": int(sum(nums)),
        "odd_count": sum(1 for n in nums if n % 2 == 1),
        "even_count": sum(1 for n in nums if n % 2 == 0),
    }


def _passes_smart_filters(nums: List[int], exclude_consecutive: bool) -> bool:
    if exclude_consecutive and any(nums[i + 1] - nums[i] == 1 for i in range(5)):
        return False
    s = sum(nums)
    if not (SUM_MIN <= s <= SUM_MAX):
        return False
    odd = sum(1 for n in nums if n % 2 == 1)
    if odd not in VALID_ODD:
        return False
    # 생일 구간(1~31)만 5개 이상 — 흔한 패턴 회피
    low = sum(1 for n in nums if n <= 31)
    if low >= 5:
        return False
    return True


def _overlap_count(a: List[int], b: List[int]) -> int:
    return len(set(a) & set(b))


def _rarity_score(nums: List[int], df: pd.DataFrame) -> float:
    """낮을수록 흔한 번호 조합(인기 패턴) — 높을수록 희귀."""
    flat = df[NUMBER_COLUMNS].to_numpy().ravel()
    counts = pd.Series(flat).value_counts()
    total = len(df)
    # 자주 나온 번호만 골라낸 조합은 점수 낮음
    freq_penalty = sum(counts.get(n, 0) / max(total, 1) for n in nums)
    low_penalty = sum(1 for n in nums if n <= 31) * 0.05
    return round(1.0 - min(0.95, freq_penalty / 6 + low_penalty), 4)


def generate_smart_sets(
    df: pd.DataFrame,
    n_sets: int = 5,
    lookback: int = 5,
    exclude_consecutive: bool = True,
    max_overlap: int = 2,
    seed: int | None = None,
) -> Dict:
    """다양화·역사적 필터·희귀도 기반 스마트 조합.

    - 총합 100~175, 홀수 2~4개 (역대 당첨 분포 근사)
    - 게임 간 번호 겹침 max_overlap 이하
    - 생일 구간(1~31) 과다 집중 회피 → 동일 당첨 시 분할 가능성 완화 참고용
    """
    rng = np.random.default_rng(seed)
    weights = build_weights(df, lookback=lookback)
    unseen = find_unseen_numbers(df, lookback)

    combinations: List[Dict] = []
    attempts = 0

    while len(combinations) < n_sets and attempts < MAX_SMART_ATTEMPTS:
        attempts += 1
        picked = sorted(int(x) for x in rng.choice(ALL_NUMBERS, size=6, replace=False, p=weights))
        if not _passes_smart_filters(picked, exclude_consecutive):
            continue
        if any(_overlap_count(picked, c["numbers"]) > max_overlap for c in combinations):
            continue
        entry = _combo_dict(picked)
        entry["rarity_score"] = _rarity_score(picked, df)
        combinations.append(entry)

    combinations.sort(key=lambda x: x.get("rarity_score", 0), reverse=True)

    result: Dict = {
        "unseen_numbers": unseen,
        "combinations": combinations,
        "strategy": "다양화+총합/홀짝 필터+희귀도",
        "disclaimer": (
            "로또는 독립시행 확률 게임입니다. 본 전략은 당첨 확률 자체를 높이지 않으며, "
            "조합 다양화·흔한 패턴 회피(당첨 시 분할 참고) 목적입니다."
        ),
    }
    if len(combinations) < n_sets:
        result["warning"] = f"요청 {n_sets}조합 중 {len(combinations)}조합만 생성됐습니다."
    return result


# =============================================================================
# 5) 가중 앙상블 (Weighted Soft Voting Matrix) 및 스마트 필터 조합 생성기
# =============================================================================
def _passes_ensemble_filters(
    comb: Tuple[int, ...],
    extinct_sections: Set[int] = None,
    avoid_popular: bool = True,
) -> bool:
    """조합이 총합, 홀짝, 고저, 연번, 공간 압축 필터를 모두 충족하는지 검증합니다."""
    # 1. 총합 필터 (100 ~ 170)
    total_sum = sum(comb)
    if not (100 <= total_sum <= 170):
        return False
        
    # 2. 홀짝 비율 필터 (3:3, 4:2, 2:4)
    odds = sum(1 for x in comb if x % 2 != 0)
    evens = 6 - odds
    if (odds, evens) not in [(3, 3), (4, 2), (2, 4)]:
        return False
        
    # 3. 고저 비율 필터 (3:3, 4:2, 2:4)
    lows = sum(1 for x in comb if x <= 22)
    highs = 6 - lows
    if (lows, highs) not in [(3, 3), (4, 2), (2, 4)]:
        return False
        
    # 4. 연번 필터 (최대 2연번 1쌍 이하, 3연번 이상 차단)
    consecutive_pairs = 0
    i = 0
    while i < len(comb) - 1:
        if comb[i+1] - comb[i] == 1:
            if i < len(comb) - 2 and comb[i+2] - comb[i+1] == 1:
                return False  # 3연번 차단
            consecutive_pairs += 1
        i += 1
    if consecutive_pairs > 1:
        return False

    # 5. 공간 압축 필터 (멸 구간 시뮬레이션 제외)
    if extinct_sections:
        for x in comb:
            section = (x - 1) // 10
            if section > 4:
                section = 4
            if section in extinct_sections:
                return False

    # 6. 공동당첨 회피 — 과다 선택되는 '인기 조합' 형태를 배제한다.
    #    ⚠️ 적중 '확률'은 어떤 선택으로도 못 올린다(로또는 i.i.d.). 다만 당첨 시 같은
    #    번호를 고른 사람이 많으면 상금을 나눠(공동당첨) 실수령액이 급감하므로, 인기
    #    형태를 피하는 것은 '기대수령액'을 높이는 수학적으로 유일하게 의미 있는 레버다.
    #    아래 형태들은 무작위 샘플에서 드물어 후보 풀 영향은 미미하다.
    if avoid_popular:
        # (a) 6개 전부 31 이하 = 생일/날짜 조합(가장 과다 선택되는 형태)
        if all(x <= 31 for x in comb):
            return False
        # (b) 등차수열(간격 일정) = 수동 인기 패턴 (예: 2, 8, 14, 20, 26, 32)
        if len({comb[i + 1] - comb[i] for i in range(len(comb) - 1)}) == 1:
            return False
        # (c) 끝자리가 전부 동일 (예: 3, 13, 23, 33, 43)
        if len({x % 10 for x in comb}) == 1:
            return False

    return True


ENSEMBLE_ALGORITHM_VERSION = "ensemble-2.0-sig-gated-coselection"


def _coselection_validation() -> Dict:
    try:
        from .stats_engine.coselection_calibration import cached_summary

        return cached_summary()
    except Exception as exc:  # noqa: BLE001
        return {"kind": "heuristic_estimate", "validated": False, "confidence": "unverified", "reason": str(exc)[:200]}


def generate_ensemble_sets(
    df: pd.DataFrame,
    n_sets: int = 15,
    lookback: int = 10,
    intent: str = "current_round",
    target_round: Optional[int] = None,
    seed: Optional[int] = None,
    decay_factor: float = 0.9,
    lambda_reg: float = 0.2,
    alpha_sig: float = 0.05
) -> Dict:
    """
    최근 5~10회차 엔진별 적중 성능을 바탕으로 동적 가중치 소프트 보팅을 수행하고
    상관관계/통계적 다수 분포 필터 및 공간 압축을 적용하여 고밀도 조합을 생성합니다.
    """
    from .prediction_signals import build_prediction_signals, backtest_signal_accuracy
    
    # 1. 대상 회차의 통합 예측 신호 가져오기 (각 번호의 출처 획득용)
    # ⚡ 신호(엔진별 번호 점수)는 결정론적 계산이라 요청 시드와 무관해야 한다. 요청 시드를
    # 그대로 넘기면 (UI 가 매번 랜덤 시드를 보내므로) build_prediction_signals 캐시가 매번
    # 미스 → 콜드 재계산 ~36s → 게이트웨이 60s 초과로 앙상블이 504 로 죽는다. 신호는 고정
    # 시드(42)로 호출해 캐시·프리워밍이 먹게 하고, '세트 다양성'은 아래 rng(요청 시드)로 낸다.
    SIGNALS_SEED = 42
    signals = build_prediction_signals(intent=intent, seed=SIGNALS_SEED, target_round=target_round)
    target = signals.get("target_round")
    
    # 전체 1~45번에 대해 엔진별 추천 여부 추출
    # 엔진 목록: machine, post_occurrence, classic, parallel_round, decade_gap (용지 신호 폐지)
    # ranked_numbers 혹은 strong_details 에서 번호별 출처 목록을 확보
    ranked_list = signals.get("ranked_numbers") or []
    # 25위 이후의 번호들도 포함하여 전체 번호 매핑 확보를 위해 ranked_list 보완 처리
    # (실제 build_prediction_signals 가 반환하는 'ranked_numbers'는 25개까지만 슬라이싱되어 있으므로, 
    # 전체 번호의 추천 여부는 build_prediction_signals 연산을 기반으로 scores/sources 역산 수행)
    
    # 신호 소스 맵 매핑 (약칭에서 백테스트 명칭으로 매핑)
    # prediction_signals 에서 사용하는 소스(추첨데이터 기반만 — 용지 신호 폐지):
    # 'machine-reversion', 'post-S', 'post-A', 'post-top20', 'classic-wilson', 'classic-huygens',
    # 'classic-fermat', 'classic-blend', 'parallel-strong', 'parallel-expected', 'parallel-fixed', 'decade-gap'
    engine_groups = {
        "machine": ["machine-reversion"],
        "post": ["post-S", "post-A", "post-top20"],
        "classic": ["classic-wilson", "classic-huygens", "classic-fermat", "classic-blend"],
        "parallel": ["parallel-strong", "parallel-expected", "parallel-fixed"],
        "decade": ["decade-gap"]
    }
    
    engine_picks: Dict[str, Set[int]] = {k: set() for k in engine_groups.keys()}
    
    # ranked_numbers 에서 역산
    for item in ranked_list:
        num = item["number"]
        srcs = item["sources"]
        for eng, keywords in engine_groups.items():
            if any(k in srcs for k in keywords):
                engine_picks[eng].add(num)
                
    # 추가로 strong_details, excluded_details 등에서도 확인 가능
    for item in signals.get("strong_details", []):
        num = item["number"]
        srcs = item["sources"]
        for eng, keywords in engine_groups.items():
            if any(k in srcs for k in keywords):
                engine_picks[eng].add(num)

    # 2. 엔진 가중치 — 통계적 유의성 게이트.
    #    최근 lookback 회차 적중을 초기하 기준(무작위)과 비교해, 다중검정(Bonferroni,
    #    엔진 수) 보정 후에도 무작위를 유의하게 넘는 엔진만 성능 가중을 받는다. 유의하지
    #    않은 적중률(소표본 노이즈)은 신호로 쓰지 않고 기여 엔진 간 동일 가중으로 둔다.
    #    (이전 구현은 10회차 정밀도를 그대로 가중치로 써 우연 변동을 신호로 사용했다.)
    import math as _math

    # 대상 회차 이전 회차만 평가(누수 차단) — 과거 target_round/복기에서 미래 당첨 참조 금지
    accuracy_data = backtest_signal_accuracy(df, target, rounds=lookback, before_round=int(target))
    n_engines = sum(1 for e in engine_groups if engine_picks[e])
    bonf_alpha = alpha_sig / max(1, n_engines)
    engine_weights: Dict[str, float] = {}
    engine_evidence: Dict[str, Dict] = {}
    for eng in engine_groups.keys():
        # 추천 번호가 0개인 엔진은 기여가 없으므로 가중치 0(표시 오도·질량 희석 방지).
        if not engine_picks[eng]:
            engine_weights[eng] = 0.0
            engine_evidence[eng] = {"available": False, "reason": "추천 번호 없음"}
            continue
        src_data = accuracy_data.get("by_source", {}).get(eng) or {}
        per_round = src_data.get("per_round", []) if src_data.get("available") else []
        # decay_factor: '엔진 성능 증거'의 시간 감쇠 — 오래된 백테스트 회차의 적중을 덜 반영한다.
        # (번호의 최근성이 아니라 모델 성적표에만 적용: 최근 번호가 더 잘 나온다는 가정 없음.)
        # 가중 합 z = (Σw·hits − Σw·E) / sqrt(Σw²·Var) — decay=1 이면 기존 단순 합과 동일.
        n_items = len(per_round)
        hits_sum = exp_sum = var_sum = 0.0
        raw_hits = raw_exp = 0.0
        for idx_r, r_info in enumerate(per_round):
            k = len(r_info.get("predicted", []))
            if k <= 0 or k >= 45:
                continue
            w_t = float(decay_factor) ** (n_items - 1 - idx_r)
            h = float(r_info.get("hits", 0))
            e = k * 6 / 45
            v = k * (6 / 45) * (39 / 45) * ((45 - k) / 44)
            hits_sum += w_t * h
            exp_sum += w_t * e
            var_sum += w_t * w_t * v
            raw_hits += h
            raw_exp += e
        n_r = len(per_round)
        if var_sum > 0:
            z = (hits_sum - exp_sum) / _math.sqrt(var_sum)
            p_val = 0.5 * _math.erfc(z / _math.sqrt(2))
        else:
            p_val = 1.0
        significant = bool(n_r >= 5 and p_val < bonf_alpha and hits_sum > exp_sum)
        engine_evidence[eng] = {
            "available": bool(per_round),
            "rounds": n_r,
            "hits": int(raw_hits),
            "expected_hits": round(raw_exp, 2),
            "lift": round(raw_hits / raw_exp, 3) if raw_exp > 0 else 0.0,
            "decayed_lift": round(hits_sum / exp_sum, 3) if exp_sum > 0 else 0.0,
            "p_value": round(float(p_val), 4),
            "significant": significant,
        }
        base = 1.0
        if significant:
            # 유의한 엔진만 관측 lift 만큼 가중(상한 2배 — 과신 방지)
            base = float(min(2.0, hits_sum / exp_sum))
        # 추천 개수가 너무 많은 엔진(넓은 그물)은 신호 집중도가 낮아 완만히 감쇠
        cur = len(engine_picks[eng])
        if cur > 15:
            base *= float(np.exp(-0.02 * (cur - 15) ** 2))
        engine_weights[eng] = base

    total_w = sum(engine_weights.values())
    if total_w > 0:
        engine_weights = {k: v / total_w for k, v in engine_weights.items()}
    else:
        engine_weights = {k: 1.0 / len(engine_weights) for k in engine_weights.keys()}
    # lambda_reg: 가중치 정규화(수축) — 기여 엔진들 사이 균등 가중 쪽으로 λ 만큼 끌어당겨
    # 한 엔진에 과도한 가중이 몰리는 것(소표본 과적합)을 막는다. λ=0 이면 수축 없음, λ=1 이면 완전 균등.
    contributing = [k for k in engine_weights if engine_picks[k]]
    weights_before_reg = {k: round(v * 100, 1) for k, v in engine_weights.items()}
    if contributing and lambda_reg > 0:
        uni = 1.0 / len(contributing)
        engine_weights = {
            k: ((1 - lambda_reg) * v + lambda_reg * uni) if k in contributing else 0.0
            for k, v in engine_weights.items()
        }
        tot = sum(engine_weights.values())
        engine_weights = {k: v / tot for k, v in engine_weights.items()}
    any_engine_significant = any(v.get("significant") for v in engine_evidence.values())

    # 3. 번호별 확률 맵 (Probability Map) 연산
    prob_map = np.zeros(46)
    for eng, pick_set in engine_picks.items():
        w = engine_weights[eng]
        for b in pick_set:
            prob_map[b] += w
            
    sum_prob = prob_map[1:].sum()
    if sum_prob > 0:
        prob_map[1:] = prob_map[1:] / sum_prob
    else:
        prob_map[1:] = 1.0 / 45.0
        
    # 4. 공간 압축 (Section Extinction) 멸 구간 선정
    section_probs = np.zeros(5)
    for ball in range(1, 46):
        sec = (ball - 1) // 10
        if sec > 4:
            sec = 4
        section_probs[sec] += prob_map[ball]
    worst_section = int(np.argmin(section_probs))
    extinct_sections = {worst_section}
    
    # 5. 가중 샘플링 기반 조합 생성 및 스마트 필터링
    rng = np.random.default_rng(seed)
    final_combinations = set()
    balls = np.arange(1, 46)
    probabilities = prob_map[1:]
    probabilities /= probabilities.sum()
    
    max_attempts = 15000
    attempts = 0
    
    while len(final_combinations) < n_sets and attempts < max_attempts:
        attempts += 1
        picked = rng.choice(balls, size=6, replace=False, p=probabilities)
        selected_comb = tuple(sorted(picked.tolist()))
        
        if _passes_ensemble_filters(selected_comb, extinct_sections):
            final_combinations.add(selected_comb)
            
    # 강제 멸 구간 조건으로 부족할 경우 필터링 완화 후 재추도
    if len(final_combinations) < n_sets:
        attempts = 0
        while len(final_combinations) < n_sets and attempts < max_attempts:
            attempts += 1
            picked = rng.choice(balls, size=6, replace=False, p=probabilities)
            selected_comb = tuple(sorted(picked.tolist()))
            # 최후 수단: 멸 구간·인기회피까지 완화해 요청 세트 수를 반드시 채운다
            # (인기 형태는 드물어 여기까지 오는 경우는 거의 없다).
            if _passes_ensemble_filters(selected_comb, extinct_sections=None, avoid_popular=False):
                final_combinations.add(selected_comb)

    # 6. 공동선택 회피 선별 — 모든 조합의 1등 확률은 동일하므로, 같은 후보 풀 안에서
    #    '남들이 덜 고를' 조합(회피 점수↑)을 우선하고 세트 간 공유 번호를 ≤3 으로 제한해
    #    다양성을 확보한다. 이는 확률이 아니라 당첨 시 기대수령액만 개선한다.
    from .stats_engine import coselection
    from .stats_engine.probability import tickets_probability as _tickets_probability

    pool_set = set(final_combinations)
    # 후보 풀 확장(요청 수의 4배) — 선별 여지를 주되 같은 가중 샘플링 분포·필터를 유지
    extra_attempts = 0
    while len(pool_set) < n_sets * 4 and extra_attempts < max_attempts:
        extra_attempts += 1
        picked = rng.choice(balls, size=6, replace=False, p=probabilities)
        comb_t = tuple(sorted(picked.tolist()))
        if _passes_ensemble_filters(comb_t, extinct_sections):
            pool_set.add(comb_t)
    scored = sorted(
        ((c, coselection.assess(c)) for c in pool_set),
        key=lambda t: (-t[1]["avoidance_score"], t[0]),
    )
    chosen: List[Tuple[Tuple[int, ...], Dict]] = []
    for c, a_ in scored:
        if len(chosen) >= n_sets:
            break
        if all(len(set(c) & set(x)) <= 3 for x, _ in chosen):
            chosen.append((c, a_))
    for c, a_ in scored:  # 다양성 제약으로 모자라면 점수 순으로 채움
        if len(chosen) >= n_sets:
            break
        if all(c != x for x, _ in chosen):
            chosen.append((c, a_))

    combinations_list = []
    for comb, assess in sorted(chosen, key=lambda t: t[0]):
        nums = list(comb)
        combinations_list.append({
            "numbers": nums,
            "sum_total": int(sum(nums)),
            "odd_count": sum(1 for n in nums if n % 2 != 0),
            "even_count": sum(1 for n in nums if n % 2 == 0),
            "coselection": {
                "avoidance_score": assess["avoidance_score"],
                "risk": assess["risk"],
                "grade": assess["grade"],
                "factors": [f["label"] for f in assess["factors"]],
            },
            "jackpot_probability": "1/8,145,060",
        })

    # UI 대응용 기여도 메타
    engine_weights_pct = {k: round(v * 100, 1) for k, v in engine_weights.items()}
    div = coselection.diversity([c["numbers"] for c in combinations_list])

    result = {
        "target_round": target,
        "engine_weights": engine_weights_pct,
        "extinct_sections": [worst_section],
        "combinations": combinations_list,
        "strategy": "엔진 후보 풀(유의성 게이트 가중) + 5대 필터 + 공간 압축 + 공동선택 회피 선별",
        "algorithm_version": ENSEMBLE_ALGORITHM_VERSION,
        "rationale": {
            "candidate_pool": "추첨데이터 5엔진(machine·post·classic·parallel·decade)의 추천 번호 합집합에서 가중 샘플링",
            "engine_evidence": engine_evidence,
            "weights_significant": any_engine_significant,
            "weighting_rule": (
                f"최근 {lookback}회 적중이 Bonferroni(α={round(bonf_alpha, 4)}) 보정 후 무작위를 유의하게 넘는 "
                "엔진만 성능 가중. 그 외는 동일 가중(우연 변동을 신호로 쓰지 않음)."
            ),
            "selection_rule": "후보 중 공동선택 회피 점수 높은 순 + 세트 간 공유 번호 ≤3",
        },
        "diversity": div,
        "params": {
            "lookback": lookback,
            "decay_factor": decay_factor,
            "decay_applies_to": "엔진 백테스트 적중(성능 증거)의 시간 가중 — 번호 최근성 가정 아님",
            "lambda_reg": lambda_reg,
            "lambda_applies_to": "엔진 가중치를 기여 엔진 균등 가중 쪽으로 수축(과도한 가중 방지)",
            "alpha_sig": alpha_sig,
            "weights_before_regularization": weights_before_reg,
        },
        "uncertainty": {
            "jackpot_probability_per_set": "1/8,145,060 (모든 조합 동일)",
            "expected_main_matches_per_set": 0.8,
            "engines_beating_random": [e for e, v in engine_evidence.items() if v.get("significant")],
            "note": (
                "엔진 적중률은 소표본(최근 회차) 기준이라 불확실성이 큽니다. 유의한 엔진이 없으면 "
                "추천 번호는 무작위 선택과 적중 기대가 같습니다."
            ),
        },
        "coselection_basis": coselection.ESTIMATE_BASIS,
        # 회피 점수의 실측 검증 요약(공식 판매액·등수별 당첨자 수) — 추정치와 실측 검증을 분리 표기
        "coselection_validation": _coselection_validation(),
        # 수학적 확률(kind=mathematical) — 백테스트·회피 점수와 분리된 필드
        "probability": _tickets_probability([c["numbers"] for c in combinations_list]),
        "disclaimer": (
            f"대상: {target}회차 추천. ⚠️ 로또는 i.i.d.라 적중 '확률'은 어떤 선택으로도 올릴 수 없습니다"
            "(모든 조합 1/8,145,060). 엔진 신호는 후보 풀을 정할 뿐 예측력이 검증되지 않았습니다. "
            "본 추천이 실제로 개선하는 것은 인기 조합(생일대역·연속·등차·규칙 배열)을 피해 당첨 시 "
            "공동당첨 분할을 줄이는 '기대수령액'뿐이며, 공동선택 점수는 실제 구매 데이터가 없는 추정치입니다."
        ),
    }
    if len(combinations_list) < n_sets:
        result["warning"] = f"요청 {n_sets}조합 중 {len(combinations_list)}조합만 생성됐습니다."
    return result

