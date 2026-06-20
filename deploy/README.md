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
