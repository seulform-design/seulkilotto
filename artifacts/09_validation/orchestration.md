# Validation — 자동 전략 폐기 오케스트레이션 (설계)

> 상태: `partial` (설계만)  
> 영역: Validation  
> **자동으로 scoring을 바꾸지 않는다. 후보·알림만.**

## 1. 목적

앙상블·full-history·역산에서 지속 열세인 신호/모델을  
**폐기 후보**로 표시하고, 사람이 Gate·Registry를 확인한 뒤에만  
`scoring_allowed=false` 로 내린다.

## 2. 원칙

| # | 규칙 |
|---|------|
| 1 | 자동 mute / 자동 가중 변경 금지 |
| 2 | 삭제는 금지 — `archived` 누적 |
| 3 | Experimental·demo·review 누수는 항상 제외 |
| 4 | 소표본이면 폐기 후보도 `small_sample` 플래그 |
| 5 | honesty·Explain에 폐기 사유 동봉 |

## 3. OrchestratorResult (목표)

```json
{
  "version": "0.1.0",
  "run_at": "ISO-8601",
  "candidates": [
    {
      "model_id": "feature:semi_rate",
      "action": "propose_disable",
      "reason": "full_history lift < baseline for N windows",
      "metrics": { "lift": 0.9, "windows": 5 },
      "requires_human": true,
      "auto_applied": false
    }
  ],
  "unchanged": [],
  "honesty": "제안만. scoring_allowed 변경은 사람 확인 후."
}
```

## 4. 입력 소스 (현행)

- `ensemble_backtest.py`
- `full_history_backtest.py`
- `review_verification` leaderboard / inverse_diagnosis
- `validation_gates` (Feature/Pattern)

## 5. 파이프라인

```
Backtest/Gates → Orchestrator(propose only) → Registry UI 표시
                      ↓
              (사람 승인 시에만)
                      ↓
         scoring_allowed=false + archived
```

## 6. 구현 스케치 (후속)

- `backend/app/video_analysis/strategy_orchestrator.py` — `propose_retirements()` only
- API: `GET .../validation/orchestrator` (읽기 전용)
- UI: ModelRegistryBlock에 `propose_disable` 칩
- **POST disable 는 별도 인증·확인 스텝 필수**

## 7. Acceptance

- [x] 설계 문서 (자동 변이 금지 명시)
- [x] `propose_retirements` 읽기 전용 헬퍼
- [x] Feature 응답 `orchestrator` + Registry UI 후보 표시
- [x] 사람 승인 disable/enable API (`confirm` + X-Upgrade-Key)
- [x] 자동 scoring mutate 회귀 테스트 (auto_applied=false)
