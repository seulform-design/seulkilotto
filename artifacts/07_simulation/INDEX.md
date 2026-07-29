# Simulation Artifact — INDEX

> 상태: `partial` (엔진 내부 MC/bootstrap만)  
> 대규모 MC(백만~억)는 Experimental

## 현재 (용지분석)

- Feature / Pattern 엔진의 bootstrap · permutation · Monte Carlo 게이트
- 경로: `feature_learning_engine.py`, `pattern_mining_engine.py`

## Experimental (미연결)

대규모 추첨 시뮬·GPU 병렬은 `100_experimental/simulation_scale.md` 참고.  
Validation 전 추천 점수에 넣지 않는다.

## 정직성

시뮬레이션은 균등난수 가정 하 기대값을 확인하는 도구다. 확률을 올리지 않는다.
