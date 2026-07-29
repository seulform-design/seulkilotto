# Draw Machine — 출처·인용

> 버전: `0.1.0` · 점수 직접 주입 금지  
> 물리 시뮬·공기압·RPM 가설 → `100_experimental`

## 공식·1차 (운영 사실)

| ID | 주제 | URL / 경로 | 비고 |
|----|------|------------|------|
| DM-DHL-INTRO | 로또6/45 소개 | https://www.dhlottery.co.kr/lt645/intro | 동행복권 |
| DM-DHL-GUIDE | 추첨방송·당첨 확인 | https://www.dhlottery.co.kr/guide/wnrGuide | 토 20:35경 |
| DM-HIST | 호기·머신 이력 CSV | `backend/data/machine_history.csv` | L9 machine 소스 |
| DM-ANALYTICS | 머신 분석 코드 | `backend/app/machine_analytics.py` | 경험적 집계 |

## 장비 인용 (2차·보도 — 과신 금지)

| ID | 진술 | 출처 | 등급 |
|----|------|------|------|
| DM-VENUS-001 | 현행 추첨기는 Editec(프랑스) Venus 계열 공기분사·드럼링 추출 방식으로 보도됨 | 뉴스와이어 등 보도 | secondary |
| DM-VENUS-UI | 앱 UI는 `Editec Venus VIII` 프리셋으로 표기 | `ComposedAnalysisPage.tsx` | product_label |
| DM-PROC-001 | 추첨 전 참관·볼세트 선정·예비기 절차가 보도됨 | 동일 계열 보도 | secondary |

공식 제조사 데이터시트·치수 PDF가 확보되기 전까지 **물리 파라미터는 Experimental** 로만 둔다.

## 용지분석 연결

| 경로 | 역할 | 점수 |
|------|------|------|
| L9 `prediction_signals` machine | 호기 경험 신호 | 규칙 기반·honesty 동봉 |
| 종합분석 물리/학습 추첨기 | 체험·시뮬 UI | 확률 불변 고지 |
| SemiAuto `machine-*` | 표시·신호 칩 | 호기 축은 추정 신뢰도 이슈로 일부 제외 정책 유지 |

## 규칙

- 출처·호기 이력 ≠ 당첨 확률 상승.
- 3D/공기압/마모 가설은 Validation 전 `100_experimental` 전용.
