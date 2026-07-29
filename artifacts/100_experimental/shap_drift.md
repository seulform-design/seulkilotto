# Experimental — SHAP / Feature Drift (설계 스텁)

> 상태: `experimental`  
> 영역: AI · Explain  
> **추천 점수·validatedLearning 주입 금지**

## 1. 목적

Feature/Pattern 기여도를 사후 설명(SHAP류)하고,  
회차 누적에 따른 Feature 분포 드리프트를 **감사**한다.  
당첨 확률을 바꾸지 않는다.

## 2. 비범위

- 자동 가중 재조정
- Gate 우회 채택
- Experimental → scoring 직행

## 3. 제안 계약 (목표 JSON)

```json
{
  "version": "0.0.1-experimental",
  "model_id": "feature:support",
  "shap": {
    "method": "permutation|kernel|planned",
    "values": {},
    "baseline": null,
    "small_sample": true
  },
  "drift": {
    "metric": "psi|ks|mean_shift",
    "window": "last_N_vs_prior",
    "score": null,
    "alert": false
  },
  "scoring_allowed": false,
  "honesty": "설명·드리프트 감사 전용. 게이트 통과 전 점수 미연결."
}
```

## 4. 현행 대체물 (이미 있는 것)

| 기능 | 위치 | 비고 |
|------|------|------|
| Permutation importance | `feature_learning_engine` ensemble | SHAP 대체 초안 |
| Feature contributions | recommend_with_contributions | 번호별 기여 |
| Gate G1–G8 | `validation_gate.py` | 채택/거절 |

## 5. 승격 조건

1. 다회차 WF에서 shap/drift 리포트가 재현 가능  
2. `evaluate_gate` 통과 모델에만 첨부  
3. UI는 Explain 블록 **부가** — core6/expand18 미변경  
4. registry에서 Experimental → `08_ai` partial 로 이동

## 6. Acceptance

- [x] Experimental 설계 문서
- [x] 공통 API stub (`GET /api/v1/photo-analysis/experimental/shap-drift`, scoring_allowed=false)
- [x] Explain `experimental: true` → UI 배너
- [ ] 실 SHAP 라이브러리·PSI (Validation 후)
