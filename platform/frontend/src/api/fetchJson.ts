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
  /**
   * 무거운 분석 엔드포인트 표시. true 면 클라이언트 동시요청 제한기를 거쳐
   * 최대 MAX_HEAVY 개만 동시에 나간다. ④ 학습 엔진이 펼쳐지면 무거운
   * photo-analysis 요청 십수 개가 한꺼번에 몰려 브라우저 동시연결 한도를
   * 넘겨 ERR_ABORTED/ERR_INSUFFICIENT_RESOURCES(네트워크 요청 초과) + 백엔드
   * 과부하 504 가 났다. 제한기로 몰림을 흡수하되 패널은 자동 로드된다(비활성 X).
   */
  heavy?: boolean;
}

// ── 무거운 요청 동시성 제한기 ──
// heavy:true 요청은 최대 MAX_HEAVY 개만 in-flight. 나머지는 큐에서 대기하다
// 슬롯이 나면 순서대로 실행된다. 경량/핵심 요청(accumulated·meta·history 등)은
// 제한기를 거치지 않으므로 무거운 요청에 굶지 않는다.
const MAX_HEAVY = 4;
let heavyActive = 0;
const heavyQueue: Array<() => void> = [];

function acquireHeavySlot(): Promise<void> {
  if (heavyActive < MAX_HEAVY) {
    heavyActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => heavyQueue.push(resolve));
}

function releaseHeavySlot(): void {
  const next = heavyQueue.shift();
  if (next) {
    // 슬롯을 대기자에게 인계 — heavyActive 는 그대로(여전히 점유 중).
    next();
  } else if (heavyActive > 0) {
    heavyActive -= 1;
  }
}

export async function fetchJson<T>(path: string, init: FetchJsonOptions = {}): Promise<T> {
  if (init.heavy) {
    await acquireHeavySlot();
    try {
      return await fetchJsonInner<T>(path, init);
    } finally {
      releaseHeavySlot();
    }
  }
  return fetchJsonInner<T>(path, init);
}

async function fetchJsonInner<T>(path: string, init: FetchJsonOptions = {}): Promise<T> {
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

  // 2xx 라도 본문이 JSON 이 아닐 수 있다(프록시 HTML 로그인/점검 페이지, 빈 본문).
  // res.json() 의 raw SyntaxError("Unexpected token <") 가 사용자에게 노출되지
  // 않도록 ApiError 로 변환한다.
  const text = await safeText(res);
  try {
    return JSON.parse(text) as T;
  } catch {
    const looksHtml = text.trimStart().startsWith('<');
    throw new ApiError(
      looksHtml
        ? '게이트웨이 연결이 일시적으로 끊겼습니다. 잠시 후 다시 시도해 주세요.'
        : '서버 응답을 해석하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      { status: res.status, kind: looksHtml ? 'tunnel_disconnected' : 'http' }
    );
  }
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
