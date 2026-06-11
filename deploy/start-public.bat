@echo off
REM 로또 분석기 공개 실행 (Windows, Cloudflare Quick Tunnel)
REM 발급된 URL 은 deploy\.tunnel-url 파일에 자동 기록됩니다.

cd /d "%~dp0.."

echo [1/2] 프론트 빌드...
pushd platform\frontend
call npm run build
if errorlevel 1 (
  popd
  exit /b 1
)
popd

echo [2/2] 서버 + 터널 시작 (mode=tunnel)...
cd deploy
node start-prod.mjs --mode tunnel
