# Explain Artifact — 표준 스키마 (초안)

> 상태: `partial`  
> 영역: Explain  
> 용지분석 연결: Feature/Pattern/Review/SemiAuto honesty·기여도

## ExplainPayload (목표 JSON)

```json
{
  "version": "0.1.0",
  "subject": { "type": "number|set|signal", "value": null },
  "decision": "recommend|exclude|neutral|coverage",
  "confidence": {
    "overall": 0,
    "statistics": 0,
    "pattern": 0,
    "model": 0,
    "simulation": 0,
    "backtest": 0
  },
  "evidence": [
    { "kind": "statistic|pattern|model|simulation|backtest|policy", "detail": "", "weight": 0 }
  ],
  "used_data": {
    "intent": "review|current_round",
    "rounds": [],
    "artifact_versions": []
  },
  "algorithms": [],
  "backtest": { "metric": "", "value": null, "baseline": null, "small_sample": true },
  "limits": [],
  "improvements": [],
  "honesty": "확률 불변. 당첨 보장 없음."
}
```

## 현재 분산 구현

- API `honesty` 문자열 (V1–V4, review, carryover…)
- Feature contributions / Pattern reasons
- `inverse_diagnosis.problems` · `actions` · `policy`
- 히어로 배너 문구 (best_single / expand18_first)

## 다음 단계

1. 공통 TypeScript 타입을 `v1Api.ts` 에 추가  
2. 신규 엔진 응답에 `explain?: ExplainPayload` 선택 필드  
3. Experimental 결과는 `decision` 과 무관하게 UI 배너만
