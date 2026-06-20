# 배포 가이드

## 영구 배포 (Railway — 운영 주소)

**공개 URL:** https://lotto-analyzer-production-8678.up.railway.app/

GitHub `seulform-design/seulkilotto` 저장소와 Railway 프로젝트가 연결되어 있으면 `main` 푸시 시 자동 배포됩니다.  
Dockerfile 기반 — 프론트 + v1/v2 API + nginx 단일 서비스.

| 확인 | 경로 |
|------|------|
| 앱 | `/` |
| v1 API | `/api/v1/meta` |
| 헬스 | `/health` |

---

## 즉시 공개 (로컬 터널 — PC 켜져 있을 때)

PC가 켜져 있어야 하며, URL은 재시작 시 바뀝니다.

```bash
cd platform/frontend && npm run build
cd ../../deploy && npm install && npm run tunnel
```

터미널에 출력되는 `trycloudflare.com` URL을 공유하세요.

```bash
npm run tunnel
# → https://xxxx.trycloudflare.com
```

---

상세 가이드: [RENDER.md](RENDER.md)

## 영구 배포 (Render — 무료)

1. GitHub에 저장소 푸시
2. [render.com](https://render.com) 가입 → **New → Blueprint**
3. 저장소 연결 → 루트의 `render.yaml` 자동 인식
4. 배포 완료 후 `https://lotto-analyzer.onrender.com` 형태의 URL 발급

Render는 클라우드에서 `Dockerfile`을 빌드하므로 로컬 Docker가 없어도 됩니다.

무료 플랜은 15분 미사용 시 슬립 모드 → 첫 접속 시 30~60초 로딩될 수 있습니다.

---

## Railway 자동 배포 (git push → 링크 갱신)

이 저장소에는 GitHub Actions 기반 Railway 배포 워크플로가 포함되어 있습니다.

- 워크플로 파일: `.github/workflows/deploy-railway.yml`
- 기본 트리거 브랜치:
  - `main`
  - `cursor/**`

즉, 아래 설정만 넣으면 `git push` 후 Railway가 같은 서비스로 다시 배포됩니다.

### 1) GitHub 저장소 Secret 추가

- `RAILWAY_TOKEN`
  - Railway 프로젝트에서 발급한 **Project Token**

### 2) GitHub 저장소 Variables 추가

- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_SERVICE_ID`
- `RAILWAY_PUBLIC_URL` (선택)

`RAILWAY_PUBLIC_URL` 을 넣어두면 Actions 실행 요약에 실제 접속 주소가 함께 표시됩니다.

### 3) 동작 방식

워크플로는 다음 명령으로 현재 push 된 커밋을 Railway 에 올립니다.

```bash
railway up --ci \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT_ID" \
  --service "$RAILWAY_SERVICE_ID"
```

### 4) 현재 운영 링크를 바로 갱신하려면

지금 쓰는 Railway 서비스의 `project / environment / service id` 를 위 변수에 넣으면 됩니다.
그러면 `main` 또는 `cursor/**` 브랜치에 push 할 때 같은 링크가 최신 커밋으로 갱신됩니다.

### 5) 쇼 프리뷰처럼 별도 링크를 쓰고 싶다면

운영 링크와 분리된 Railway 서비스(또는 environment)를 하나 더 만든 뒤:

1. preview 용 `SERVICE_ID / ENVIRONMENT_ID` 를 따로 준비
2. 이 워크플로를 복제하거나 브랜치 조건을 나눠서
3. `cursor/**` 는 preview 서비스로, `main` 은 운영 서비스로 보내면 됩니다.

즉:

- `main` → 운영 URL
- `cursor/**` → 미리보기 URL

구성도 가능합니다.
