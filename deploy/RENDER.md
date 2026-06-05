# Render 영구 배포 가이드

## 1. GitHub에 푸시

```bash
cd lotto-analyzer
git init   # 최초 1회
git add .
git commit -m "로또 분석기 통합 배포"
git remote add origin https://github.com/YOUR_USER/lotto-analyzer.git
git push -u origin main
```

## 2. Render Blueprint 배포

1. [render.com](https://render.com) 로그인
2. **New → Blueprint**
3. GitHub 저장소 연결
4. `render.yaml` 자동 인식 → **Apply**

## 3. 배포 후 URL

`https://lotto-analyzer.onrender.com` (서비스명에 따라 변경)

- 대시보드 · 회차 업그레이드 · 번호생성 · 연구분석 모두 단일 URL
- 무료 플랜: 15분 미사용 시 슬립 → 첫 접속 30~60초 대기

## 4. 운영 환경변수 (Render Dashboard)

| 변수 | 권장값 |
|------|--------|
| `SCHEDULER_ENABLED` | `true` (매주 토 22:30 자동 회차 업그레이드) |
| `UPGRADE_API_KEY` | 임의 문자열 (수동 업그레이드 API 보호) |
| `ADMIN_API_KEY` | v2 admin 보호용 |
| `CORS_ORIGINS` | `https://your-app.onrender.com` |

## 5. 회차 자동 업그레이드

Render 배포 시 `SCHEDULER_ENABLED=true` 이면:
- 매주 토요일 22:30 동행복권 크롤
- CSV + v2 DB 자동 갱신
- 수동: 앱 「회차」 탭 → **최신 회차 업그레이드**
