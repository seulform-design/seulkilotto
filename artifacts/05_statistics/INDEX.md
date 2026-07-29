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

- (없음 — 히스토리 스토어 API 추가됨. 장기 보존 정책만 운영 선택)

## 구현

- Serializer: `backend/app/epo/statistics_snapshot.py` (decade hit_rate 포함)
- Store: `backend/app/epo/snapshot_store.py` → `data/statistics_snapshots/`
- API:
  - `GET /api/v1/stats/snapshot` (`persist=true` 시 누적 저장)
  - `GET /api/v1/stats/snapshot/history`
  - `GET /api/v1/stats/snapshot/history/{filename}`
- **점수 미연결**

## 규칙

스냅샷은 재현·Explain용. Experimental·Ball 가설과 합치지 않는다.  
저장된 파일은 삭제하지 않고 누적한다.
