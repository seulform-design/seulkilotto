import { resolveApiUrl } from '../config/runtime';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: 'tunnel_timeout' | 'tunnel_disconnected' | 'http' | 'network';
  constructor(message: string, opts: { status: number; kind: ApiError['kind'] }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.kind = opts.kind;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface FetchJsonOptions extends RequestInit {
  /** ms. 기본 30s. 0 이하 또는 미지정 시 디폴트 적용. */
  timeoutMs?: number;
}

export async function fetchJson<T>(path: string, init: FetchJsonOptions = {}): Promise<T> {
  const url = resolveApiUrl(path);
  const { timeoutMs, signal: externalSignal, headers, ...rest } = init;

  const controller = new AbortController();
  const effectiveTimeout = !timeoutMs || timeoutMs <= 0 ? DEFAULT_TIMEOUT_MS : timeoutMs;
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  // 외부 signal 과 내부 timeout 을 합성: 둘 중 하나라도 abort 시 요청 중단
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    throw new ApiError(
      aborted
        ? '요청 시간 초과 — 네트워크 상태를 확인해 주세요.'
        : '네트워크 연결 실패 — 잠시 후 다시 시도해 주세요.',
      { status: 0, kind: aborted ? 'tunnel_timeout' : 'network' }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const raw = await safeText(res);
    const detail = extractDetail(raw);

    // Cloudflare 524 = origin 응답 지연. 분석 API 의 장기 작업에서 자주 발생.
    if (res.status === 524 || /524|timeout occurred/i.test(detail)) {
      throw new ApiError(
        '게이트웨이 응답 시간 초과(524). 분석 작업이 너무 오래 걸렸습니다. 잠시 후 다시 시도하거나 입력 범위를 줄여 주세요.',
        { status: 524, kind: 'tunnel_timeout' }
      );
    }

    // 터널 끊김 시 HTML 에러 페이지가 반환되는 경우
    if (detail.startsWith('<!DOCTYPE') || detail.startsWith('<html')) {
      throw new ApiError(
        '게이트웨이 연결이 일시적으로 끊겼습니다. 잠시 후 다시 시도해 주세요.',
        { status: res.status, kind: 'tunnel_disconnected' }
      );
    }

    throw new ApiError(`API 오류 (${res.status}): ${detail.slice(0, 300)}`, {
      status: res.status,
      kind: 'http',
    });
  }

  return (await res.json()) as T;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function extractDetail(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not json — fall through */
  }
  return raw;
}
