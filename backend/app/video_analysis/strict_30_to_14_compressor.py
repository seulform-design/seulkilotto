"""
엄격한 결정론적 30수 -> 14수 압축 및 스코어 복원 데이터 파이프라인 모듈
"""
from typing import Any, Dict, List, Set, Tuple

def strict_30_to_14_compressor(
    gangsu_gidaesu_30_pool: List[int],
    engine_outputs: Dict[str, Any],
    *,
    sigs: Dict[str, Dict[int, float]],
    auto_lines: List[List[int]] | None = None,
    semi_lines: List[List[int]] | None = None,
    engine_boosts: Dict[str, float] | None = None,
    learning_numbers: List[int] | None = None,
    carryover_numbers: List[int] | None = None,
    size: int = 14
) -> Tuple[List[int], Dict[str, Any]]:
    """
    [용지분석/번호추천 섹션 수정 가이드라인]
    1. PRIMARY_MASK 선언: 입력받은 'gangsu_gidaesu_30_pool'을 엄격한 하드 마스크로 간주합니다.
    2. Hard Boundary: 이 마스크 외의 번호는 최종 14수 추천에 절대 진입할 수 없습니다. (비트마스킹/인덱스 필터링)
    3. 스코어 보존 법칙: 최소 2개 이상의 엔진이 공통으로 지지하는 번호에 최우선 가산점(+150.0)을 부가하여, 
       실제 당첨 번호가 정밀 필터링 하위 컷으로 인해 본망 밖으로 밀려나는 것을 완전히 방지합니다.
    4. Re-ranking: LOO 평균 기여도, 분산 회소성(낮은 빈도), 구간별 분포 가중치를 매핑하여 30수 내에서 순위를 재배열합니다.
    """
    # 1. PRIMARY_MASK 하드 선언
    PRIMARY_MASK: Set[int] = set(int(n) for n in gangsu_gidaesu_30_pool if 1 <= int(n) <= 45)
    
    # 2. 엔진별 지지 조건 분석
    boost = engine_boosts or {}
    multi_order = list(engine_outputs.get("multi_order") or [])
    order_pos = {n: i for i, n in enumerate(multi_order)}
    
    # 일치레벨 스코어
    from .review_verification import _match_level_reverse_scores
    match_sc = _match_level_reverse_scores(auto_lines or [], semi_lines or [])
    match_max = max((match_sc.get(n, 0.0) for n in PRIMARY_MASK), default=0.0) or 1.0
    
    # 각 엔진별 집합 구성
    multi_meta = engine_outputs.get("multi_meta") or {}
    agree2 = set(multi_meta.get("cross_agree_ge2") or [])
    agree3 = set(multi_meta.get("cross_agree_ge3") or [])
    mid_both = set(multi_meta.get("mid_both_side") or [])
    strong = set(multi_meta.get("decade_strong") or [])
    expected = set(multi_meta.get("decade_expected") or [])
    watch = set(multi_meta.get("decade_watch") or [])
    learn = set(int(n) for n in (learning_numbers or []) if 1 <= int(n) <= 45)
    carry = set(int(n) for n in (carryover_numbers or []) if 1 <= int(n) <= 45)
    
    pair = sigs.get("pair_product") or {}
    pair_max = max((float(pair.get(n, 0)) for n in PRIMARY_MASK), default=0.0) or 1.0
    tb = sigs.get("total_freq") or {}
    af = sigs.get("auto_freq") or {}
    sf = sigs.get("semi_freq") or {}

    scored_cands: List[Tuple[int, float, Dict[str, Any]]] = []

    # 3. 30수 내 번호들에만 한정 매핑하여 재연산 및 스코어 복원
    for n in PRIMARY_MASK:
        s = 0.0
        
        # 각 엔진 기여 카운트
        supported_engines = 0
        tags = []
        
        if order_pos.get(n, 45) < 24:
            supported_engines += 1
            tags.append("다중엔진")
        if match_sc.get(n, 0.0) > 0.0:
            supported_engines += 1
            tags.append("일치레벨")
        if n in agree2 or n in agree3:
            supported_engines += 1
            tags.append("교차합의")
        if n in strong:
            supported_engines += 1
            tags.append("강수")
        if n in expected or n in watch:
            supported_engines += 1
            tags.append("기대수")
        if n in mid_both:
            supported_engines += 1
            tags.append("중간양쪽")
        if float(pair.get(n, 0)) > 0.0:
            supported_engines += 1
            tags.append("1:1곱")
        if n in learn:
            supported_engines += 1
            tags.append("학습")
        if n in carry:
            supported_engines += 1
            tags.append("이월")
            
        # (1) LOO 평균 적중률 기여도 반영
        s += max(0, 45 - order_pos.get(n, 45)) * 2.2 * float(boost.get("multi", 1.0))
        s += (float(match_sc.get(n, 0)) / match_max) * 30.0 * float(boost.get("match_level", 1.0))
        
        if n in agree3:
            s += 18.0 * float(boost.get("cross_agree", 1.0))
        elif n in agree2:
            s += 10.0 * float(boost.get("cross_agree", 1.0))
            
        if n in strong:
            s += 52.0 * float(boost.get("decade_strong", 1.0))
        if n in expected:
            s += 48.0 * float(boost.get("decade_expected", 1.25))
        if n in watch:
            s += 44.0 * float(boost.get("decade_expected", 1.15))
        if n in mid_both:
            s += 22.0 * float(boost.get("mid_both", 1.2))
            
        # 양쪽 등장 중빈도 가산
        if float(af.get(n, 0)) > 0 and float(sf.get(n, 0)) > 0:
            tot = float(tb.get(n, 0))
            if tot <= 0:
                s += 6.0
            elif tot <= 8:
                s += 24.0
            elif tot <= 16:
                s += 14.0
            else:
                s += 4.0
                
        if n in learn:
            s += 14.0
        if n in carry:
            s += 10.0
            
        s += (float(pair.get(n, 0)) / pair_max) * 12.0 * float(boost.get("pair_product", 1.0))
        s += min(3.0, float(tb.get(n, 0)) * 0.05)

        # (2) [규칙 2] 스코어 보존 법칙: 최소 2개 엔진 공통 지지 시 최우선 가산점 부여
        if supported_engines >= 2:
            s += 150.0
            
        # (3) 분산 회소성 반영 (번호의 빈도가 낮을수록 가산)
        tot_freq = float(tb.get(n, 0))
        s += (20.0 - min(20.0, tot_freq)) * 1.5
        
        # (4) 구간별 분포 가중치
        decade_band = min(4, (n - 1) // 10)
        s += (5 - decade_band) * 1.0 # 고른 분산 보조

        scored_cands.append((n, s, {
            "score": s,
            "supported_engines": supported_engines,
            "tags": tags
        }))

    # 4. 정렬 및 정확히 상위 14수 선별 (size 개수 보장)
    scored_cands.sort(key=lambda x: (-x[1], x[0]))
    
    out = [x[0] for x in scored_cands[:size]]
    
    provenance = {}
    for n, s, meta in scored_cands[:size]:
        provenance[str(n)] = meta["tags"]
        
    meta = {
        "pool": list(PRIMARY_MASK),
        "universe_size": len(PRIMARY_MASK),
        "provenance": provenance,
        "ranked": [x[0] for x in scored_cands]
    }
    
    return out, meta
