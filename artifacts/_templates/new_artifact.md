# Artifact: {{ARTIFACT_ID}} — {{TITLE}}

> 상태: `planned` | `partial` | `active` | `experimental` | `archived`  
> 영역: Knowledge | Historical | DrawMachine | Ball | Statistics | Pattern | Simulation | AI | Validation | Explain | Experimental  
> 용지분석 연결: 엔진① L? / 엔진② / 엔진③ V? / 엔진④ L9 / 없음(독립)

## 1. 목적

한 문장으로: 이 Artifact가 **무엇을 축적·검증**하는가. (번호 보장 금지)

## 2. 비범위 (Out of Scope)

- 통계 모델에 넣지 않을 내용
- Experimental 전용 여부

## 3. 데이터 계약

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| version | string | Y | semver |
| round_scope | `archived` \| `review` \| `current_round` | Y | 누수 방지 |
| honesty | string | Y | 한계·확률 불변 고지 |

### 입력

-

### 출력

- confidence (0–100, 근거별 분리 권장)
- used_data / algorithms / backtest / limits / next_improvements

## 4. 파이프라인 위치

`Collect → Clean → Validate → Stats → Pattern → Simulation → AI → Ensemble → Explain → Backtest → Store`

이 Artifact가 끼는 단계: **____**

## 5. 검증 필수

- [ ] Walk-forward / 다회차 백테스트
- [ ] 누수 없음 (`review` 사후복기 ≠ 학습 표본)
- [ ] 고정수(`fixed_semi`) 처리 여부 명시
- [ ] 무작위 기대(6/45, top-K) 대비 lift + 소표본 보수
- [ ] `honesty` 문구

## 6. 구현 스케치

- Backend 모듈: `backend/app/video_analysis/` 또는 독립 패키지
- API: `/api/v1/photo-analysis/...`
- Frontend: Panel 또는 SemiAuto 슬롯
- 추천 주입: **허용 / 금지 / Experimental만**

## 7. Acceptance

- [ ] registry.json 갱신
- [ ] 단위 테스트
- [ ] UI에 한계·근거 표시
- [ ] 기존 L1–L9 / V1–V4 동작을 깨지 않음
