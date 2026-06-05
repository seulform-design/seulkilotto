# 배포 가이드

## 즉시 공개 (로컬 터널)

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
