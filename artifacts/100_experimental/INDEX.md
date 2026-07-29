# Experimental Artifact — 격리 구역

> 상태: `active` (격리 전용)  
> 영역: Experimental  
> 용지분석 연결: **없음 — 추천·검증학습 점수 주입 금지**

## 1. 목적

미검증 가설·미신·연구용 아이디어를 **안전하게** 보관한다.  
기존 L1–L9 / V1–V4 / 히어로 추천을 깨지 않는다.

## 2. 허용 콘텐츠

- 무속 · 점술 · 예언 · 꿈 · 사주 · 풍수 (문화·UX 실험)
- 미검증 Feature / Pattern / 물리 시뮬 가설
- 대규모 MC·DL·GNN·Markov 설계 초안
- Auto Research 가설 초안

## 3. 금지

- `validatedLearning` / L1-B / 히어로 core6·expand18 점수 경로 연결
- “당첨 확률 상승” 문구를 사실처럼 표시
- Historical 학습 표본에 사후 복기 누수

## 4. 승격 절차 (Experimental → 본선)

1. `_templates/new_artifact.md` 로 정식 Artifact 초안  
2. Walk-forward / 다회차 / (가능하면) full-history 백테스트  
3. 소표본 보수·honesty 통과  
4. `registry.json` status를 `partial`/`active` 로 변경  
5. 코드 연결은 PR 단위 · 기존 엔진 회귀 테스트

## 5. 하위 폴더 관례

```
100_experimental/
  hypotheses/     # 가설 메모
  superstition/   # 미신·점술 UX 실험 (점수 무관)
  research/       # Auto Research 초안
```

지금은 디렉터리만 필요 시 생성한다.

## 현재 문서

- `ball_hypothesis.md` — 볼 물리 가설
- `simulation_scale.md` — 대규모 MC
- `shap_drift.md` — SHAP/Drift 설계 (점수 미연결)
