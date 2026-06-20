# Enterprise Lottery Data Isolation

이 문서는 **Historical Dataset (읽기 전용)** 과 **Current Dataset (샌드박스)** 의 물리·논리적 격리 원칙을 정의합니다.

## 핵심 원칙

```
[Historical (Immutable)] → [Current Rule Engine] → [Derived Generation] → [Current Sandbox]
```

- **Rule 1 (No Leakage):** Current 샌드박스 데이터는 토요일 공식 추첨·롤오버 검증 전 Historical에 쓰일 수 없음
- **Rule 2 (No Passive Coupling):** 과거 데이터는 Pure Function 인자로만 사용, 결과는 Current에 독립 저장
- **Rule 3 (No Context Contamination):** 추천 재생성이 Historical 카운트를 변형하지 않음

## 구현 위치 (v1 backend)

| 영역 | 경로 | 역할 |
|------|------|------|
| Historical 게이트웨이 | `backend/app/datasets/historical.py` | 확정 회차 draws 스냅숏, 아카이브 조회 |
| Current 샌드박스 | `backend/app/datasets/current.py` | N회차 용지·파생 추천 R/W |
| 규칙 엔진 | `backend/app/pipeline/rule_engine.py` | 통계기반 추천 독립 생산 |
| 무결성 게이트 | `backend/app/pipeline/integrity.py` | Integrity / Leakage / Consistency |
| 토요일 롤오버 | `backend/app/pipeline/rollover.py` | Freeze → Backtest → Merge → Flush |
| 용지 브리지 | `backend/app/datasets/photo_bridge.py` | `current_round` intent → 샌드박스만 쓰기 |

### 파일 저장 (PostgreSQL 미연결 시)

```
backend/data/datasets/
  historical/
    round_archives.json    # 롤오버 후 확정 스냅숏
    rollover_log.json      # 멱등성 로그
  current/
    sandbox_state.json
    photo_entries.json
    derived_recommendations.json
```

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/v1/datasets/status` | 격리 상태 |
| GET | `/api/v1/datasets/current/derived` | 이번 회차 파생 추천 이력 |
| POST | `/api/v1/datasets/rollover` | 롤오버 수동 실행 (멱등) |
| GET | `/api/v1/generate/weights?scope=current` | 규칙 엔진 + 샌드박스 저장 |
| GET | `/api/v1/generate/smart?scope=current` | 동일 |

`scope=ephemeral` (기본) 은 기존 일회성 응답 — 하위 호환.

## 토요일 롤오버 (자동)

`round_upgrade.upgrade_rounds()` 성공 후 `maybe_rollover_after_upgrade()` 가 신규 확정 회차에 대해:

1. **Freeze** — Current Write 차단
2. **Backtest** — 규칙 추천 vs 당첨번호
3. **Integrity Gate** — 3중 검증, 실패 시 Abort + Unfreeze
4. **Atomic Merge** — Historical 아카이브 (유일한 대량 쓰기)
5. **Sandbox Init** — N+1 빈 샌드박스

## PostgreSQL (선택)

`backend/sql/schema_isolation.sql` — DB 레벨 아카이브 테이블 + `lotto_history` UPDATE 가드.

## 용지 분석

- `video_intent=current_round` → **Current Sandbox** (`photo_entries.json`)
- `video_intent=review` → 레거시 JSON (복기 맥락)
- 롤오버 시 current 용지는 Historical 아카이브로 이관 후 샌드박스 Flush

## 확장 예정

- EPO / 가중치 외 모든 추천 엔진 `scope=current` 통합
- v2 `pair_pattern_stats` 를 Historical 전용 materialized view 로 격리
- 프론트엔드 기본 `scope=current` 전환
