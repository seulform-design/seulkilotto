# Lotto Knowledge Artifact System (용지분석 정렬)

프롬프트 **V1 Knowledge / V2 Brain Core / V3 Enterprise / V4 Auto Research** 를  
현재 **용지분석 엔진(L1–L9 · V1–V4 · 역산·백테스트)** 에 맞춰 정리한 단일 문서다.

기계 가독 카탈로그·생성 큐: [`artifacts/registry.json`](../artifacts/registry.json)  
생성 절차: [`artifacts/README.md`](../artifacts/README.md)

---

## 1. ROLE (에이전트·개발자 공통)

20년급 아키텍트·데이터사이언티스트·통계·엔지니어·로또 분석가 관점으로  
**번호 추천이 아니라 Lotto Knowledge Artifact System** 을 확장한다.

- 모듈형 · 신규 데이터가 기존을 깨지 않음
- Clean Architecture / DDD / SOLID / Repository / Service / DI / Test / CI·CD 지향
- 최종 목표는 “맞춘다”가 아니라 **학습→검증→폐기→개선이 도는 연구 플랫폼**

---

## 2. 핵심 원칙

| # | 원칙 |
|---|------|
| 1 | 번호를 억지로 예측하지 않는다 |
| 2 | 확률을 속이지 않는다 (i.i.d., 1/8,145,060) |
| 3 | 미검증 이론은 **가설·Experimental** |
| 4 | 분석은 재현 가능해야 한다 |
| 5 | 데이터·모델은 버전 관리 |
| 6 | 결과는 백테스트 가능해야 한다 |
| 7 | 기존 데이터는 삭제하지 않고 누적 |
| 8 | 자동 수정 금지 — 수정 **후보**만 |
| 9 | 출력에 신뢰도·데이터·알고리즘·백테스트·한계·개선을 동봉 |
| 10 | 무속·점술·예언·꿈·사주는 Experimental 전용, 통계·점수 금지 |

---

## 3. 용지분석에 이미 있는 것 (Present)

### 3.1 엔진 맵

| Artifact 축 | 용지분석 구현 |
|-------------|---------------|
| Ticket / Round | `store` · `PhotoAnalysisPage` · `apply_intent` (복기/이번회차) |
| Repeat / 1:1 | 엔진① L1 (+ L8 교차) |
| Pattern learn | L2 당첨 패턴 학습 · L3 출현 패턴 · L5–L7 |
| Deep / Network | L8 심층 |
| Parallel | 엔진② |
| Feature / ML light | 엔진③ V1 (`feature_learning_engine`) |
| Pattern mining | V2 |
| Round calib | V3 |
| Overlap | V4-A/B · carryover |
| Prediction signals | 엔진④ L9 |
| Validation | `review_verification` · LOO · significance · ensemble · full_history |
| Explain (부분) | Panel honesty · 기여도 · 역산 진단 UI |
| Historical isolation | `docs/DATA_ISOLATION.md` · datasets historical/current |
| Draw machine (부분) | `machine_history` · L9 machine source · 종합분석 추첨기 |

### 3.2 확정 추천 정책

```
core6  = best_single   (다회차 1위 단일신호 — 합의 희석 금지)
expand18 = best_of_engines (min-rank — catchable recall)
prefer_consensus = false
고정수 fixed_semi = 지지·패턴·랭킹에서 제외
archived_demo_* = 점수 주입 금지
```

### 3.3 학습·검증 사이클 (이미 도는 축)

```
용지 수집 → 정제/중복제거 → intent 분리 → 통계·패턴 →
검증학습(V1–V4) → 역산/백테스트 → 정책(inverse_diagnosis) →
히어로·주입(이번회차만 forward) → 복기 대조 → 재분석
```

프롬프트의 `Data → Knowledge → Intelligence → Validation → Learning` 과 대응.

---

## 4. 없는 것 / 부분만 있는 것 (Gap → 생성 대상)

`registry.json` 의 `generation_queue` 와 `core_artifacts[].status` 가 소스 오브 트루스다.

**용지분석 런타임 완성도** (`registry.completeness.sheet_engine_runtime`): 검수·백테스트 게이트 기준 ~96%.  
Ball / 대규모 MC / DL·GNN 등은 데이터·실험 영역이라 Experimental로 남기고, 점수 경로에는 넣지 않는다.

| ID | 상태 | 생성 방향 |
|----|------|-----------|
| `01_knowledge` | partial | export 0.1.1 · DM-* 교차 · 제조사 PDF 후속 |
| `03_draw_machine` | partial | SOURCES 0.1.0 · 제조사 PDF blocked · 물리는 Experimental |
| `04_ball` | missing | 볼 단위 스펙 — 데이터 없으면 Experimental 설계만 |
| `05_statistics` | partial | snapshot·decade·히스토리 스토어 완료 |
| `07_simulation` | partial | 대규모 MC는 Experimental 스펙 후 검증 |
| `08_ai` | partial | Registry UI · SHAP/Drift Experimental 설계 |
| `09_validation` | active | propose·disable·nested stub · outer hit 후속 |
| `10_explain` | partial | Explain + Experimental 배너 완료 |
| `100_experimental` | partial | 볼·대규모 MC 가설 격리 |
| Enterprise 32 graph, 39 markov, 40 bayesian, 42–44 DL, 66 shap, 67 drift, 80 event, 87 registry… | missing | 필요 시 템플릿으로 추가, **점수 연결은 Validation 통과 후** |

---

## 5. Artifact 10종 (V1) ↔ 구현

1. **Knowledge** — 문서+registry (확장 중)
2. **Historical** — datasets + CSV
3. **Draw Machine** — machine analytics (물리 시뮬 갭)
4. **Ball** — 없음
5. **Statistics** — 분산 구현, 통합 스키마 갭
6. **Pattern** — V2 + L패턴 활성
7. **Simulation** — 엔진 내부 MC/bootstrap
8. **AI** — sklearn 실험 · vision OCR
9. **Validation** — 강함 (역산·WF·LOO·천장 검정)
10. **Explain** — UI 분산, 표준 스키마 갭

---

## 6. Brain Core (V2) 매핑

| Core 개념 | 현재 |
|-----------|------|
| Memory (Knowledge/Historical/Pattern/…) | 코드·스토어에 분산, 단일 Memory API 없음 |
| Self Learning (회차 후 복기·가중 수정) | 롤오버·역산·재분석 부분 자동화 |
| Confidence 0–100 | 부분(신뢰도·covConf), 통합 Confidence Engine 없음 |
| Multi AI + Ensemble 가중 자동 | V1 ensemble 실험 · 정책은 best_single/min-rank |
| Feature Engine | V1 채택/기각 · Permutation |
| Pattern Discovery | V2 |
| Anomaly | 약함 |
| Simulation Engine | 소규모 |
| Backtest Engine | 강함 |
| Auto Improvement (모델 자동 off) | 정책·저성과 신호 배제 수준 |
| Knowledge Graph | 없음 |
| Explainable AI | 부분 |
| Safety | honesty 문자열·면책·Experimental 규칙(문서) |

---

## 7. Enterprise 01–100 (V3)

전체 목록과 `active|partial|missing` 는 `artifacts/registry.json` → `enterprise_directory`.  
**폴더를 100개 미리 만들지 않는다.** 필요 Artifact만 `artifacts/<id>/` 로 생성한다.

---

## 8. Auto Research (V4)

목표 루프:

```
Collect → Hypothesis → Feature → Pattern → Simulation →
Train → Validation → Backtest → Evaluate → Knowledge Update → Repeat
```

현재: Feature/Pattern 채택 게이트 + 역산 정책 + 앙상블/전이력 천장 검정.  
자동 가설 생성·토너먼트·메타러닝·실패 원인 자동분류는 **미구축** → `99_research` / `100_experimental` 에서만 설계.

---

## 9. AI 분석 순서 (출력 계약)

모든 신규 모듈·리포트는 가능하면 포함:

1. 사용 데이터·버전·intent  
2. 알고리즘  
3. 검증 방식 (WF / LOO / multi-round / full-history)  
4. 백테스트 수치 + 소표본 경고  
5. Confidence (항목별)  
6. 장단점·한계·개선  
7. `honesty` (확률 불변)

---

## 10. 금지

- 당첨 보장·확률 향상 단정  
- Experimental → 추천 점수 주입  
- 복기(사후) 용지를 학습 표본에 누수  
- `archived_demo_*` 를 이번회차 점수로 사용  
- 합의(consensus)로 core6 희석  

---

## 11. 관련 문서

- [`DATA_ISOLATION.md`](./DATA_ISOLATION.md) — Historical vs Current  
- [`artifacts/README.md`](../artifacts/README.md) — 생성 절차  
- `.cursor/rules/lotto-knowledge-artifact.mdc` — 에이전트 규칙  
