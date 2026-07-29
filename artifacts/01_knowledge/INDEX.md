# Knowledge Artifact — 시드 인덱스

> 상태: `partial`  
> 영역: Knowledge  
> 용지분석 연결: 전 엔진 공통 원칙 (점수 계산 아님)  
> 출처: [`SOURCES.md`](./SOURCES.md) · export: [`export.json`](./export.json) `0.1.1`

## 1. 목적

로또·용지분석에 대한 **검증된 지식·운영 원칙**을 한곳에 둔다.  
번호를 예측하지 않는다.

## 2. 확정 사실 (시드)

| ID | 진술 | 근거 등급 |
|----|------|-----------|
| K-PROB-001 | 한국 로또 6/45 1등 확률은 1/8,145,060 | 조합론 · 공식 |
| K-IID-001 | 회차 간 추첨은 독립에 가깝게 설계됨(i.i.d. 가정) | 운영·통계 가정 |
| K-TICKET-001 | 티켓에 없는 번호는 티켓 기반 엔진으로 포착 불가(천장) | 복기 역산 |
| K-FIXED-001 | 반자동 고정수는 지지·패턴 신호에서 제외해야 오염 방지 | video_analysis |
| K-CORE-001 | 핵심6은 다회차 best 단일신호; 합의는 희석 | ensemble backtest |
| K-EXP-001 | 확장18은 전 엔진 min-rank(best_of_engines) | review_verification |
| K-INTENT-001 | `review`=소급 대조, `current_round`=예상·forward 주입 | apply_intent |
| K-DEMO-001 | `archived_demo_*` 는 표시용 — 점수 주입 금지 | SemiAuto inject |

## 3. 가설 (Knowledge에 넣되 점수용 금지)

별도 Experimental로 이관 권장:

- 볼 마모·호기 물리가 번호 분포를 편향시킨다  
- 특정 패턴·궁합수가 장기적으로 우위를 갖는다  

→ Validation 통과 전 추천 가중치에 연결하지 말 것.

## 4. 확장 큐

- 추첨기·볼 규격 공식 스펙 인용 정리 (`03_draw_machine` / `04_ball`)
- Monte Carlo / Bayesian / Markov 개념 요약 (교육용, Experimental과 분리)

## 5. Acceptance

- [x] registry `01_knowledge` partial
- [x] 공식 출처 URL (`SOURCES.md`)
- [x] 버전드 JSON export (`export.json` 0.1.1 · draw-machine DM-* 교차)
