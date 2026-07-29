# Knowledge — 공식·검증 출처

> 버전: `0.1.1` · 점수 계산에 쓰지 않음  
> export: [`export.json`](./export.json)  
> 교차: [`../03_draw_machine/SOURCES.md`](../03_draw_machine/SOURCES.md) (DM-*)

## 공식·1차 출처

| ID | 주제 | URL | 비고 |
|----|------|-----|------|
| SRC-DHL-INTRO | 로또6/45 소개·당첨확률 | https://www.dhlottery.co.kr/lt645/intro | 동행복권 공식 — 1등 1/8,145,060 |
| SRC-DHL-GUIDE | 당첨 확인·추첨방송 안내 | https://www.dhlottery.co.kr/guide/wnrGuide | 매주 토 20:35경 |
| SRC-COMB-001 | 조합론 C(45,6)=8,145,060 | (수학) | K-PROB-001 근거 |

## 프로젝트 내부 근거 (코드·문서)

| ID | 주제 | 경로 |
|----|------|------|
| SRC-POLICY-CORE | 핵심6 best_single | `review_verification.py` `_inverse_diagnosis.policy` |
| SRC-POLICY-EXP | 확장18 min-rank | 동상 |
| SRC-DATA-ISO | 데이터 격리 | `docs/DATA_ISOLATION.md` |
| SRC-ARTIFACT | Artifact 체계 | `docs/LOTTO_KNOWLEDGE_ARTIFACT_SYSTEM.md` |
| SRC-FIXED | 고정수 제외 | `feature_learning_engine` / SemiAuto |

## 2차·참고 (과신 금지)

| ID | URL | 용도 |
|----|-----|------|
| REF-WIKI-KR | https://ko.wikipedia.org/wiki/동행복권 | 등위·확률 표 요약(공식 대체 아님) |

## 규칙

- 출처 URL은 Knowledge/Explain용. **추천 가중치에 직접 연결하지 않는다.**
- Experimental 가설 출처는 `100_experimental` 에만 둔다.
