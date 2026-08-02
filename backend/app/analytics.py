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
    extinct_sections: Set[int] = None
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
                
    return True


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
    signals = build_prediction_signals(intent=intent, seed=seed, target_round=target_round)
    target = signals.get("target_round")
    
    # 전체 1~45번에 대해 엔진별 추천 여부 추출
    # 엔진 목록: machine, post_occurrence, classic, photo_sheet, parallel_round, decade_gap
    # ranked_numbers 혹은 strong_details 에서 번호별 출처 목록을 확보
    ranked_list = signals.get("ranked_numbers") or []
    # 25위 이후의 번호들도 포함하여 전체 번호 매핑 확보를 위해 ranked_list 보완 처리
    # (실제 build_prediction_signals 가 반환하는 'ranked_numbers'는 25개까지만 슬라이싱되어 있으므로, 
    # 전체 번호의 추천 여부는 build_prediction_signals 연산을 기반으로 scores/sources 역산 수행)
    
    # 신호 소스 맵 매핑 (약칭에서 백테스트 명칭으로 매핑)
    # prediction_signals 에서 사용하는 소스: 
    # 'machine-reversion', 'post-S', 'post-A', 'post-top20', 'classic-wilson', 'classic-huygens', 'classic-fermat', 'classic-blend',
    # 'photo-line-overlap', 'photo-vote', 'photo-pair', 'photo-triple', 'parallel-strong', 'parallel-expected', 'parallel-fixed', 'decade-gap'
    engine_groups = {
        "machine": ["machine-reversion"],
        "post": ["post-S", "post-A", "post-top20"],
        "classic": ["classic-wilson", "classic-huygens", "classic-fermat", "classic-blend"],
        "photo": ["photo-line-overlap", "photo-vote", "photo-pair", "photo-triple"],
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

    # 2. 최근 N회차 백테스트 적중률 스코어링을 통한 동적 가중치 부여
    accuracy_data = backtest_signal_accuracy(df, target, rounds=lookback)
    engine_weights = {}
    
    # 백테스팅 결과를 지수 시간 감쇄 가중치로 가중합
    for eng in engine_groups.keys():
        # post 및 photo 는 속도/입력 의존성으로 인해 백테스트가 누락되거나 제한적일 수 있으므로
        # 기본 가중치를 주되 다른 엔진들의 평균값에 동조시킴
        src_data = accuracy_data.get("by_source", {}).get(eng)
        
        if src_data and src_data.get("available"):
            per_round = src_data.get("per_round", [])
            n_rounds = len(per_round)
            
            # 지수 감쇄 가중치 생성
            weights = np.array([decay_factor ** (n_rounds - 1 - i) for i in range(n_rounds)])
            weights /= weights.sum()
            
            precisions = []
            p_values = []
            for i, r_info in enumerate(per_round):
                hits = r_info.get("hits", 0)
                pred_cnt = len(r_info.get("predicted", []))
                precision = hits / pred_cnt if pred_cnt > 0 else 0
                precisions.append(precision)
                
                # p-value 계산 (45개 중 6개 당첨, pred_cnt 개 추천하여 hits 개 적중)
                p_val = 1.0 if hits == 0 else float(hypergeom.sf(hits - 1, 45, 6, pred_cnt))
                p_values.append(p_val)
                
            weighted_precision = float(np.sum(np.array(precisions) * weights))
            mean_p_value = float(np.mean(p_values))
            
            # 노이즈 패널티 규제 적용
            p_penalty = 1.0 if mean_p_value < alpha_sig else np.exp(-lambda_reg * (mean_p_value - alpha_sig) * 10)
            
            # 추천 개수가 너무 많은 과적합 엔진 패널티
            current_pick_len = len(engine_picks[eng])
            pick_penalty = 1.0
            if current_pick_len > 15:
                pick_penalty = np.exp(-0.02 * (current_pick_len - 15) ** 2)
                
            engine_weights[eng] = weighted_precision * p_penalty * pick_penalty
        else:
            # 백테스트 불가능한 엔진 (photo, post 등)은 기본 가중치 적용
            if eng == "photo":
                engine_weights[eng] = 0.08  # 용지 기반 중립 가중치
            elif eng == "post":
                engine_weights[eng] = 0.12  # 후속출현 중립 가중치
            else:
                engine_weights[eng] = 0.05
                
    total_w = sum(engine_weights.values())
    if total_w > 0:
        engine_weights = {k: v / total_w for k, v in engine_weights.items()}
    else:
        engine_weights = {k: 1.0 / len(engine_weights) for k in engine_weights.keys()}
        
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
            if _passes_ensemble_filters(selected_comb, extinct_sections=None):
                final_combinations.add(selected_comb)

    combinations_list = []
    for comb in sorted(list(final_combinations)):
        nums = list(comb)
        combinations_list.append({
            "numbers": nums,
            "sum_total": int(sum(nums)),
            "odd_count": sum(1 for n in nums if n % 2 != 0),
            "even_count": sum(1 for n in nums if n % 2 == 0),
        })
        
    # UI 대응용 기여도 메타
    engine_weights_pct = {k: round(v * 100, 1) for k, v in engine_weights.items()}
    
    return {
        "target_round": target,
        "engine_weights": engine_weights_pct,
        "extinct_sections": [worst_section],
        "combinations": combinations_list,
        "strategy": "가중 투표 앙상블 + 5대 스마트 필터 + 공간 압축",
        "disclaimer": (
            f"대상: {target}회차 추천. 각 분석 엔진의 최근 {lookback}회차 실시간 적중 정밀도를 "
            "기반으로 가중합산(Soft Voting)하여 통계적 다수 분포 영역 및 공간 압축 시뮬레이션을 거친 고밀도 조합입니다."
        )
    }

