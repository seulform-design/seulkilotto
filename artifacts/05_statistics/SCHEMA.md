# Statistics Artifact — 버전드 스냅샷 스키마

> 상태: `partial`  
> 영역: Statistics  
> 용지분석 연결: EPO `HistoricalProfile` · decade 밴드 · video_analysis/stats  
> 버전: `0.1.0`

## 1. 목적

과거 1등·용지 관측을 **재현 가능한 통계 스냅샷**으로 고정한다.  
예측·당첨 보장이 아니라 필터 기본값·Explain·백테스트 기준선에 쓴다.

## 2. 비범위

- Ball 물리량, 무속·사주, Experimental MC 결과 → 이 스키마에 넣지 않음
- 모델 가중·추천 점수 직접 주입 (AI/Validation 경유)

## 3. StatisticsSnapshot (목표 JSON)

```json
{
  "version": "0.1.0",
  "artifact_id": "05_statistics",
  "created_at": "ISO-8601",
  "round_scope": "archived",
  "source": {
    "dataset": "historical|current_round|sheet_review",
    "rounds": { "from": 1, "to": 1200, "count": 1200 },
    "exclude_intents": ["review"]
  },
  "empirical": {
    "sum": { "p01": 63, "p10": 100, "p50": 138, "p90": 175, "p99": 213, "mean": 138.0 },
    "odd_count_freq": { "0": 0.01, "1": 0.1, "2": 0.24, "3": 0.32, "4": 0.24, "5": 0.08, "6": 0.01 },
    "high_count_freq": { "0": 0.01, "1": 0.08, "2": 0.24, "3": 0.32, "4": 0.24, "5": 0.1, "6": 0.01 },
    "odd_count_modes": [2, 3, 4],
    "high_count_modes": [2, 3, 4],
    "ac": { "mean": 7.4, "p10": 6 },
    "max_run_p95": 2
  },
  "decade_bands": {
    "labels": ["1-10", "11-20", "21-30", "31-40", "41-45"],
    "hit_rate_per_band": [0.2, 0.2, 0.2, 0.2, 0.2],
    "expected_per_band": [0.222222, 0.222222, 0.222222, 0.222222, 0.111111],
    "note": "용지 L3/decade UI와 동일 5밴드; 관측 비율(점수 미연결)"
  },
  "frequency": {
    "number_counts": {},
    "window": "all|last_N",
    "window_n": null
  },
  "baselines": {
    "uniform_hit_prob": 0.133333,
    "uniform_top6_hits": 0.8,
    "jackpot_odds": "1/8145060"
  },
  "honesty": "경험적 분포일 뿐이며 i.i.d.·당첨 확률을 바꾸지 않는다.",
  "mapped_impl": {
    "epo_profile": "backend/app/epo/historical_stats.py#HistoricalProfile",
    "significance": "backend/app/video_analysis/stats.py"
  }
}
```

## 4. EPO 정렬

| Snapshot 필드 | `HistoricalProfile` |
|---------------|---------------------|
| `empirical.sum.p01..p99, mean` | `sum_p01` … `sum_mean` |
| `odd_count_freq` / `modes` | `odd_count_freq` / `odd_count_modes` |
| `high_count_freq` / `modes` | `high_count_freq` / `high_count_modes` |
| `ac.mean` / `ac.p10` | `avg_ac` / `p10_ac` |
| `max_run_p95` | `max_run_p95` |
| `source.rounds.count` | `rounds_analyzed` |

`last_round_*` 는 스냅샷의 `carry` 옵션 필드로만 두고, 기본 export에는 넣지 않는다(누수·의도 혼동 방지).

## 5. 파이프라인 위치

`Collect → Clean → Validate →` **Stats** `→ Pattern → …`

## 6. 검증 필수

- [ ] `round_scope` / `exclude_intents` 명시 (review 누수 금지)
- [ ] 표본 0이면 EPO `_FALLBACK` 과 동일 보수값
- [ ] `baselines.uniform_*` 고정·문서화
- [ ] `honesty` 동봉
- [ ] 버전 bump 시 이전 스냅샷 삭제하지 않고 누적

## 7. 구현 스케치 (후속)

1. ~~`HistoricalProfile` → `StatisticsSnapshot` serializer (JSON export)~~
2. ~~API: 선택 `GET /api/v1/stats/snapshot`~~
3. Explain `used_data.artifact_versions` 에 `05_statistics@0.1.0` 기입 (V1 등)
4. **추천 점수 직접 연결 금지** — EPO 필터·Explain 기준선만

## 8. Acceptance

- [x] 스키마 문서 (`SCHEMA.md`)
- [x] serializer + 단위 테스트
- [x] registry `mapped_paths` 갱신
- [x] 기존 EPO/용지 UI 동작 불변
