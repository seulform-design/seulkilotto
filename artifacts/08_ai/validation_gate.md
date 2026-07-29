# AI Validation Gate — 점수 주입 전 게이트

> 상태: `partial` (설계)  
> 영역: AI · Validation  
> 선행 조건: 이 게이트 통과 전 Model Registry 항목을 추천 점수에 넣지 않는다.

## 1. 목적

새 모델·피처·패턴 후보가 **용지분석 추천 경로**에 들어가기 전에  
다회차·소표본·누수·고정수 규칙을 통과했는지 판정한다.

## 2. Gate checklist (필수)

| # | 검사 | 기준 (현행 엔진과 정렬) | 실패 시 |
|---|------|-------------------------|---------|
| G1 | Walk-forward | 평균 top6 hits ≥ uniform baseline(`≈0.8`) × lift | reject |
| G2 | 전·후반 안정 | early/late 모두 기준선 근처 이상 | reject |
| G3 | MC / permutation | lift vs MC + p 유의 (엔진 채택 규칙) | reject |
| G4 | Intent 분리 | `review` 사후 용지 학습 표본 제외 | reject |
| G5 | Demo 차단 | `archived_demo_*` forward 주입 금지 | reject |
| G6 | fixed_semi | 고정수는 지지·랭킹·패턴 제외 | reject |
| G7 | Honesty | 응답에 limits·honesty | reject |
| G8 | Experimental | `100_experimental` 출처면 점수 경로 금지 | reject (UI만) |

현행 구현 참조:

- Feature: `feature_learning_engine.py` adopt 조건
- Pattern: `pattern_mining_engine.py` adopt 조건
- 정책: `review_verification.py` `_inverse_diagnosis.policy`

## 3. GateResult (목표 JSON)

```json
{
  "version": "0.1.0",
  "model_id": "feature:support",
  "status": "passed|rejected|experimental_only",
  "checks": [
    { "id": "G1", "ok": true, "detail": "" }
  ],
  "metrics": {
    "wf_mean_hits": null,
    "lift_vs_uniform": null,
    "permutation_p": null,
    "small_sample": true
  },
  "scoring_allowed": false,
  "honesty": "게이트 통과 ≠ 당첨 확률 상승. i.i.d. 유지."
}
```

## 4. Rollback / Tournament (설계만)

| 개념 | 규칙 |
|------|------|
| Rollback | 직전 `passed` + `scoring_allowed` 버전으로 되돌림. 실패 버전은 `archived` 유지(삭제 금지) |
| Tournament | 후보끼리 동일 WF·동일 round_scope로 비교. 승자만 `scoring_allowed` |
| Auto-disable | full_history / ensemble 천장 검정에서 지속 열세면 `scoring_allowed=false` 후보 |

UI·자동 오케스트레이션은 **미구축**. Registry에 `planned` 로만 기록.

## 5. 파이프라인

`… → AI(후보) →` **Validation Gate** `→ Ensemble → Explain → …`  
Gate 실패 시 Ensemble/추천 주입 스킵, Explain에 reject 근거만.

## 6. Acceptance

- [x] 게이트 체크리스트·GateResult 스키마
- [x] 공통 `evaluate_gate()` / feature·pattern 어댑터
- [x] Feature/Pattern 응답 `last_gate` · `validation_gates` 요약
- [x] Feature/Pattern 패널 Gate·scoring 허용 UI
- [ ] Model Registry Rollback·토너먼트 UI
- [ ] 점수 경로에 Experimental 유입 테스트 (CI e2e)
