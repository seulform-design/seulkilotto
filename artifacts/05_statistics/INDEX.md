# Statistics Artifact — INDEX

> 상태: `partial`  
> 스키마: [`SCHEMA.md`](./SCHEMA.md) `0.1.0`

## 현재 (코드)

| 모듈 | 역할 |
|------|------|
| `backend/app/epo/historical_stats.py` | 1등 조합 경험적 분포 (`HistoricalProfile`) |
| `backend/app/epo/filters.py` | sum / odd / decade / AC 측정 |
| `backend/app/video_analysis/stats.py` | 이항 유의·기대 FP |
| SemiAuto decade UI | 5밴드 관측·표시 |

## 갭

- 통합 JSON 스냅샷 export 미구현 (스키마만 확정)
- frequency window·decade hit_rate 자동 산출 미통일

## 규칙

스냅샷은 재현·Explain용. Experimental·Ball 가설과 합치지 않는다.
