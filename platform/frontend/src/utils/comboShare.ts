/**
 * 조합 공유/저장 유틸 — Canvas 이미지 + Web Share + Clipboard.
 *
 * 설계:
 *  - Canvas 2D 로 직접 그려 외부 의존성(html2canvas 등) 0
 *  - Web Share API → 없으면 클립보드 텍스트로 fallback
 *  - 이미지는 Blob 으로 반환되어 다운로드, 공유, 미리보기에 재사용 가능
 *
 * 톤 일관성: 색상은 theme/colors.ts 의 getBallColor 와 동일 매핑.
 */
import { getBallColor } from '../theme/colors';

export interface ComboImageOptions {
  numbers: number[];
  title?: string;
  subtitle?: string;
  /** 출력 폭 (px). 기본 720 (해상도 충분). */
  width?: number;
  /** Device pixel ratio 적용 여부 — 고DPI 디스플레이용. 기본 2 (선명). */
  dpr?: number;
}

const BG = '#1C1F24';
const FG = '#FFFFFF';
const SUBTLE = '#9BA1A9';

function isLightColor(num: number): boolean {
  return num <= 10 || num > 40;
}

function pickTextColor(num: number): string {
  return isLightColor(num) ? '#2A2A2A' : '#FFFFFF';
}

/**
 * 6개 번호를 PNG Blob 으로 렌더링.
 * Canvas 미지원 환경(서버, 비-브라우저)에서는 reject.
 */
export function renderComboImage(opts: ComboImageOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Canvas 사용 불가 — 브라우저 환경이 아닙니다.'));
      return;
    }
    const { numbers, title = '🎱 로또 추천 번호', subtitle, width = 720, dpr = 2 } = opts;
    if (!Array.isArray(numbers) || numbers.length !== 6) {
      reject(new Error('번호 6개가 필요합니다.'));
      return;
    }

    const height = subtitle ? 280 : 240;
    const canvas = document.createElement('canvas');
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas 2D 컨텍스트 획득 실패'));
      return;
    }
    ctx.scale(dpr, dpr);

    // 배경
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    // 헤더
    ctx.fillStyle = FG;
    ctx.font = '700 22px -apple-system, "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 28, 28);

    if (subtitle) {
      ctx.fillStyle = SUBTLE;
      ctx.font = '400 14px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.fillText(subtitle, 28, 60);
    }

    // 6 공 렌더링
    const sorted = [...numbers].sort((a, b) => a - b);
    const ballSize = 80;
    const totalBalls = sorted.length;
    const gap = 16;
    const totalW = totalBalls * ballSize + (totalBalls - 1) * gap;
    const startX = (width - totalW) / 2;
    const cy = subtitle ? 175 : 145;

    sorted.forEach((n, idx) => {
      const cx = startX + idx * (ballSize + gap) + ballSize / 2;
      // 그림자
      ctx.beginPath();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = getBallColor(n);
      ctx.arc(cx, cy, ballSize / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // 번호
      ctx.fillStyle = pickTextColor(n);
      ctx.font = '700 30px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), cx, cy + 1);
    });

    // 푸터
    ctx.fillStyle = SUBTLE;
    ctx.font = '400 12px -apple-system, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(
      '※ 본 조합은 통계 분석 결과일 뿐이며 당첨을 보장하지 않습니다.',
      28,
      height - 32
    );

    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('이미지 변환 실패'));
    }, 'image/png');
  });
}

/** Blob 을 사용자 다운로드로 트리거. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 조합을 사람이 읽기 좋은 텍스트로 포맷. */
export function formatComboText(numbers: number[], opts: { withDisclaimer?: boolean } = {}): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const main = `🎱 추천 번호: ${sorted.join(', ')}`;
  if (opts.withDisclaimer) {
    return `${main}\n※ 통계 분석 결과 · 당첨 보장 아님`;
  }
  return main;
}

export type ShareResult =
  | { ok: true; via: 'web-share' | 'clipboard' }
  | { ok: false; reason: 'cancelled' | 'unsupported' | 'error'; message?: string };

/**
 * Web Share API 우선 시도 → 실패/미지원 시 클립보드로 fallback.
 * iOS Safari/Android Chrome 은 Web Share 지원, 데스크탑 Chrome 은 일부.
 */
export async function shareCombo(
  numbers: number[],
  opts: { title?: string; url?: string; includeImage?: boolean } = {}
): Promise<ShareResult> {
  const text = formatComboText(numbers, { withDisclaimer: true });
  const title = opts.title ?? '로또 추천 번호';
  const shareUrl = opts.url ?? (typeof window !== 'undefined' ? window.location.href : '');

  // 1) Web Share API 시도 (이미지 포함 가능 시)
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      const payload: ShareData = { title, text, url: shareUrl };
      if (opts.includeImage && typeof navigator.canShare === 'function') {
        try {
          const blob = await renderComboImage({ numbers });
          const file = new File([blob], 'lotto-combo.png', { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            payload.files = [file];
          }
        } catch {
          /* 이미지 실패 시 텍스트만 공유 */
        }
      }
      await navigator.share(payload);
      return { ok: true, via: 'web-share' };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, reason: 'cancelled' };
      }
      // Web Share 실패 → 클립보드 fallback
    }
  }

  // 2) 클립보드 fallback
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(`${text}\n${shareUrl}`);
      return { ok: true, via: 'clipboard' };
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        message: err instanceof Error ? err.message : '클립보드 쓰기 실패',
      };
    }
  }

  return { ok: false, reason: 'unsupported' };
}
