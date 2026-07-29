# Experimental — 대규모 Monte Carlo 스케일 설계

> 상태: `experimental` · **점수 주입 금지**

## 목표 스케일 (설계만)

| 규모 | 용도 | 상태 |
|------|------|------|
| 1e4–1e5 | 엔진 내부 게이트 (현재) | active |
| 1e6 | 분포·부분일치 검증 | planned |
| 1e7+ | 연구용 천장 검정 | planned |
| GPU/병렬 | 성능 | missing |

## 승격 조건

1. Walk-forward / full-history와 모순 없음  
2. 소표본·과적합 고지  
3. honesty에 “확률 불변” 명시  
4. registry `07_simulation` status → partial/active

## 금지

히어로·validatedLearning·L9 점수에 직접 연결하지 말 것.
