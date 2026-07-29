# Lotto Knowledge Artifact System

용지분석(Photo / Sheet Analysis)을 중심으로 한 **지식·검증 Artifact** 저장소입니다.  
프롬프트 V1~V4(Knowledge / Brain Core / Enterprise / Auto Research)를 **현재 코드베이스에 매핑**하고, 없는 항목은 `registry.json` 상태 `missing` / `experimental` 로 표시해 **생성·확장**할 수 있게 합니다.

## 절대 원칙 (Safety)

- 번호를 맞춘다고 주장하지 않는다. 당첨을 보장하지 않는다.
- 확률을 왜곡하지 않는다. (로또 i.i.d. · 1등 확률 1/8,145,060 불변)
- 미검증 이론은 `100_experimental` 에만 두고 통계·추천 점수에 넣지 않는다.
- 모든 결과는 근거·한계·백테스트와 함께 제시한다.

## 추천 정책 (용지분석 확정)

| 역할 | 모드 | 근거 |
|------|------|------|
| 핵심6 | `best_single` | 합의는 희석(앙상블 백테스트) |
| 확장18 | `best_of_engines` (min-rank) | catchable 당첨 recall |
| `prefer_consensus` | 항상 false | 하위호환만 |

코드: `backend/app/video_analysis/review_verification.py` → `_inverse_diagnosis.policy`

## 파일

| 경로 | 역할 |
|------|------|
| [`registry.json`](./registry.json) | Artifact 카탈로그·갭·엔진 매핑 (생성 소스) |
| [`_templates/new_artifact.md`](./_templates/new_artifact.md) | 신규 Artifact 생성 템플릿 |
| [`../docs/LOTTO_KNOWLEDGE_ARTIFACT_SYSTEM.md`](../docs/LOTTO_KNOWLEDGE_ARTIFACT_SYSTEM.md) | 전체 원칙·구조·갭 문서 |

## 없는 Artifact 추가 절차

1. `registry.json` 에서 `status: "missing"` 또는 `partial` 항목을 고른다.
2. `_templates/new_artifact.md` 를 복사해 `artifacts/<id>/INDEX.md` 를 만든다.
3. 구현이 필요하면 **기존 모듈을 깨지 않는** 독립 모듈로 추가한다 (Loose coupling).
4. Experimental 이면 `artifacts/100_experimental/` 아래에만 두고 추천 주입 경로에 연결하지 않는다.
5. `registry.json` 의 `status` / `mapped_paths` / `last_updated` 를 갱신한다.
6. 가능하면 단위 테스트 + 정직성(`honesty`) 문구를 함께 넣는다.

## 관련 코드 (용지분석)

- Hub UI: `platform/frontend/src/components/SemiAutoComparePanel.tsx`
- 학습·검증: `backend/app/video_analysis/`
- 데이터 격리: `docs/DATA_ISOLATION.md`
