# AI / Model Registry

> 상태: `partial`  
> 영역: AI  
> 용지분석 연결: 엔진③ V1 ensemble 실험 · Vision OCR  
> Validation: [`validation_gate.md`](./validation_gate.md)

## 현재 등록 (코드 기준)

| Model / Method | 위치 | 용도 | Gate | Scoring 주입 |
|----------------|------|------|------|--------------|
| Feature walk-forward + bootstrap/perm/MC | `feature_learning_engine.py` | Feature 채택 | G1–G7 내장 | 채택 feature만 (이번회차, demo 제외) |
| sklearn ensemble 실험 | 동 모듈 `_try_sklearn_models` | 참고 | 실험 | 조건부 |
| Pattern mining adopt gate | `pattern_mining_engine.py` | Pattern 채택 | G1–G7 내장 | 이번회차, demo 제외 |
| Vision LLM OCR | `vision_llm.py` | 용지 인식 | N/A | 번호 예측 아님 |

## ModelEntry 스키마 (목표)

```json
{
  "model_id": "feature:support",
  "semver": "0.1.0",
  "family": "feature|pattern|sklearn|vision|experimental",
  "status": "active|planned|rejected|archived|experimental",
  "round_scope": "current_round",
  "last_gate": { "status": "passed", "at": "ISO-8601" },
  "scoring_allowed": true,
  "rollback_of": null,
  "honesty": "확률 불변. 당첨 보장 없음."
}
```

## Rollback (설계)

1. 새 버전 Gate 실패 또는 운영 열세 → `scoring_allowed=false`, `status=archived`
2. 직전 활성 `semver` 를 다시 `scoring_allowed=true`
3. 아카이브 삭제 금지 (학습 사이클 누적)

## Tournament (planned)

- 동일 Validation 표본·동일 metric(top6/top18 lift)으로 후보 비교
- 승자만 Registry `active`
- XGBoost / CatBoost / LightGBM / LSTM / Transformer / GNN 은 **먼저 Experimental** 등록 후 Gate

## 미구축

- [ ] Rollback·토너먼트 UI
- [ ] SHAP / Feature Drift
- [ ] 자동 가중·자동 비활성 오케스트레이션

## 구현됨 (코드)

- `validation_gate.py` — `evaluate_gate` · feature/pattern 어댑터
- Feature/Pattern 응답: `last_gate`, `validation_gates`

## 규칙

새 모델은 이 문서 또는 `100_experimental`에 등록하고,  
[`validation_gate.md`](./validation_gate.md) 통과 전 추천 점수에 넣지 않는다.
