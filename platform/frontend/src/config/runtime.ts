/**
 * 런타임 설정의 단일 진입점.
 *
 * 모든 환경 의존 값은 이 모듈을 거치도록 강제한다.
 * 컴포넌트나 API 클라이언트에서 import.meta.env 를 직접 참조하는 것을 금지하고
 * 여기서 정규화된 값만 export 한다.
 */

type RuntimeEnv = Partial<ImportMetaEnv> & {
  MODE?: string;
  DEV?: boolean;
  PROD?: boolean;
};

function readEnv(): RuntimeEnv {
  if (typeof import.meta === 'undefined' || !import.meta.env) return {};
  return import.meta.env as unknown as RuntimeEnv;
}

const env = readEnv();

function normalizeBase(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 끝의 슬래시는 제거: '/api/v1' 와 결합 시 중복 슬래시 방지
  return trimmed.replace(/\/+$/, '');
}

export const runtime = {
  /** 비어 있으면 동일 origin (게이트웨이 경유) 으로 간주 */
  apiBase: normalizeBase(env.VITE_API_BASE),
  envLabel: (env.VITE_ENV_LABEL ?? '').trim(),
  isDev: Boolean(env.DEV),
  isProd: Boolean(env.PROD),
  mode: env.MODE ?? 'production',
} as const;

/**
 * 상대 API 경로를 절대 URL로 정규화한다.
 * - apiBase 가 비어 있으면 입력 path 를 그대로 반환 (상대경로 → 동일 origin).
 * - path 가 이미 절대 URL 이면 그대로 반환 (혹시 호출자가 외부 URL 을 넣은 경우 안전망).
 */
export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!runtime.apiBase) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${runtime.apiBase}${normalized}`;
}
