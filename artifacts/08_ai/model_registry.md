# AI / Model Registry — 스텁

> 상태: `partial`  
> 영역: AI  
> 용지분석 연결: 엔진③ V1 ensemble 실험 · Vision OCR

## 현재 등록 (코드 기준)

| Model / Method | 위치 | 용도 | Validation | Scoring 주입 |
|----------------|------|------|------------|--------------|
| Feature walk-forward + bootstrap/perm/MC | `feature_learning_engine.py` | Feature 채택 | 활성 | 채택 feature만 (이번회차, demo 제외) |
| sklearn ensemble 실험 | 동 모듈 `_try_sklearn_models` | 참고 | 실험 | 조건부 |
| Pattern mining adopt gate | `pattern_mining_engine.py` | Pattern 채택 | 활성 | 이번회차, demo 제외 |
| Vision LLM OCR | `vision_llm.py` | 용지 인식 | N/A | 번호 예측 아님 |

## 미구축 (생성 큐)

- Model v1/v2 Rollback
- XGBoost / CatBoost / LightGBM / LSTM / Transformer / GNN 토너먼트
- 백테스트 기반 자동 가중·자동 비활성
- SHAP / Feature Drift

## 규칙

새 모델은 먼저 `100_experimental` 또는 이 문서에 **planned** 로 등록하고,  
Validation Artifact 게이트 통과 전 추천 점수에 넣지 않는다.
