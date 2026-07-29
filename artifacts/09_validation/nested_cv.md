# Validation — Nested Walk-Forward / Nested CV (설계)

> 상태: `partial` (설계)  
> 영역: Validation  
> **점수 자동 변경 금지. 리포트·후보만.**

## 1. 목적

바깥 루프에서 회차를 홀드아웃하고, 안쪽 루프에서만 하이퍼·Feature 채택을 고른 뒤  
바깥에서 **한 번만** 평가한다.  
선택 편향(안쪽에서 고른 모델이 바깥에서도 좋아 보이는 착시)을 줄인다.

## 2. 현행 (이미 있는 것)

| 기법 | 위치 | Nested? |
|------|------|---------|
| Walk-forward Feature | `feature_learning_engine` | 단일 루프 |
| Time-split early/late | 동상 | 분할만 |
| Pattern WF | `pattern_mining_engine` | 단일 루프 |
| Full-history WF | `full_history_backtest` | 전략 고정 |

## 3. Nested 프로토콜 (목표)

```
for outer_test_round in rounds[warmup:]:
  train = rounds[:outer_test_round]
  # inner: only on train[:-inner_hold] vs train[-inner_hold:]
  candidates = tune_on_inner(train)
  pick = best_candidate(candidates)   # 채택 기준 = gate G1–G8
  score = evaluate(pick, outer_test_round)  # 한 번만
aggregate(scores) → NestedCVReport
```

- `scoring_allowed` 는 Nested 통과 + 기존 Gate + 사람 승인 후에만
- 소표본이면 `small_sample=true`, significant 강제 False

## 4. NestedCVReport (목표 JSON)

```json
{
  "version": "0.1.0",
  "experimental": false,
  "outer_folds": 0,
  "inner_folds": 0,
  "mean_top6": null,
  "baseline_top6": 0.8,
  "lift_vs_uniform": null,
  "small_sample": true,
  "picked_models": [],
  "scoring_allowed": false,
  "honesty": "Nested CV는 선택 편향 완화용. 당첨 확률 불변."
}
```

## 5. 비범위

- Nested 결과로 자동 core6/expand18 변경
- Experimental 물리/SHAP을 Nested에 섞기

## 6. 구현 스케치

- `backend/app/video_analysis/nested_cv.py` — `run_nested_feature_cv` (**0.2.0** outer top6 hits)
- API: `GET /api/v1/photo-analysis/nested-cv`
- **scoring_allowed=false** 고정 (Gate·사람 승인 전)

## 7. Acceptance

- [x] 설계 문서
- [x] 스텁 + outer top6 hit 집계
- [ ] outer≥5 실운영 표본에서 안정성 리포트
- [ ] Gate 연동 후 선택적 승격
