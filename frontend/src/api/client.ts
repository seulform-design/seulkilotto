/**
 * 백엔드 API 클라이언트.
 *
 * Failed to fetch 방지:
 * - EXPO_PUBLIC_API_URL 환경변수 우선
 * - 웹: 현재 페이지 호스트 + :8000 (Expo 웹과 API 동일 PC 가정)
 * - Android 에뮬레이터: 10.0.2.2:8000
 * - 실기기: PC LAN IP 를 .env 에 설정 (예: http://192.168.0.5:8000)
 */
import { Platform } from 'react-native';

import { localAnalyzeCombination } from './localFallback';

export function getApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim().replace(/\/$/, '');
  }

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const host = window.location.hostname || '127.0.0.1';
    return `http://${host}:8000`;
  }

  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:8000';
  }

  return 'http://127.0.0.1:8000';
}

const REQUEST_TIMEOUT_MS = 12000;

export interface LatestDraw {
  round: number;
  draw_date: string;
  numbers: number[];
  bonus: number;
  current_round?: number;
  next_round?: number;
  data_source?: string;
}

export interface AppMeta {
  ok: boolean;
  source: string;
  current_round: number;
  latest_round: number;
  next_round: number;
  row_count: number;
  gap_count: number;
  is_complete: boolean;
  first_round?: number;
  csv_path?: string;
}

export interface FrequencyItem {
  number: number;
  count: number;
  ratio: number;
}
export interface FrequencyResponse {
  total_rounds: number;
  items: FrequencyItem[];
}

export interface CombinationAnalysis {
  numbers: number[];
  odd_count: number;
  even_count: number;
  sum_total: number;
  sum_band: string;
  has_consecutive: boolean;
  consecutive_pairs: number[][];
}

export interface GeneratedCombination {
  numbers: number[];
  sum_total: number;
  odd_count: number;
  even_count: number;
}
export interface GenerateResponse {
  unseen_numbers: number[];
  combinations: GeneratedCombination[];
}

export interface RoundRecommendResponse {
  next_round: number;
  next_draw_date: string;
  machine_id: number;
  auto_machine_id: number;
  latest_round: number;
  stats: {
    draw_count: number;
    hot_top5: { number: number; count: number }[];
    cold_top5: { number: number; gap_rounds: number }[];
    consecutive_top3: { pair: number[]; count: number }[];
    synergy_top3: { pair: number[]; count: number }[];
    avg_sum: number;
    avg_odd: number;
  };
  combinations: GeneratedCombination[];
  warning?: string | null;
  filter_rule: string;
  compose_rule: string;
}

function formatFetchError(err: unknown, path: string): string {
  const base = getApiBaseUrl();
  if (err instanceof TypeError && /fetch|network/i.test(String(err.message))) {
    return (
      `서버에 연결할 수 없습니다 (Failed to fetch).\n` +
      `백엔드를 실행했는지 확인하세요:\n` +
      `  cd lotto-analyzer/backend\n` +
      `  python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000\n` +
      `API 주소: ${base}${path}`
    );
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: controller.signal,
      ...init,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 && path.includes('/recommend/')) {
        throw new Error(
          `회차 추천 API를 찾을 수 없습니다 (404).\n` +
            `백엔드를 최신 코드로 재시작하세요:\n` +
            `  cd lotto-analyzer/backend\n` +
            `  python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000\n` +
            `확인: ${getApiBaseUrl()}/docs 에 /api/v1/recommend/round 가 있어야 합니다.`
        );
      }
      throw new Error(`API 오류 (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`요청 시간 초과 (${REQUEST_TIMEOUT_MS}ms): ${url}`);
    }
    throw new Error(formatFetchError(err, path));
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => request<{ status: string; data_source?: string; is_complete?: boolean }>('/health'),

  getMeta: () => request<AppMeta>('/api/v1/meta'),

  getLatestDraw: () => request<LatestDraw>('/api/v1/history/latest'),

  getFrequency: (recentN?: number) =>
    request<FrequencyResponse>(
      `/api/v1/stats/frequency${recentN ? `?recent_n=${recentN}` : ''}`
    ),

  analyzeCombination: async (numbers: number[]): Promise<CombinationAnalysis> => {
    if (numbers.length !== 6 || new Set(numbers).size !== 6) {
      throw new Error('유효하지 않은 번호 조합입니다.');
    }
    try {
      return await request<CombinationAnalysis>('/api/v1/analyze/combination', {
        method: 'POST',
        body: JSON.stringify({ numbers }),
      });
    } catch (err) {
      if (err instanceof TypeError || (err instanceof Error && /연결|fetch|시간 초과/i.test(err.message))) {
        return localAnalyzeCombination(numbers);
      }
      throw err;
    }
  },

  generateWeighted: (params: {
    nSets?: number;
    lookback?: number;
    excludeConsecutive?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params.nSets) q.set('n_sets', String(params.nSets));
    if (params.lookback) q.set('lookback', String(params.lookback));
    if (params.excludeConsecutive !== undefined) {
      q.set('exclude_consecutive', String(params.excludeConsecutive));
    }
    return request<GenerateResponse>(`/api/v1/generate/weights?${q.toString()}`);
  },

  /** 다음 회차 호기 기반 추천 5게임 */
  getRoundRecommend: (machine?: 1 | 2 | 3, seed?: number) => {
    const q = new URLSearchParams();
    if (machine) q.set('machine', String(machine));
    if (seed !== undefined) q.set('seed', String(seed));
    const qs = q.toString();
    return request<RoundRecommendResponse>(
      `/api/v1/recommend/round${qs ? `?${qs}` : ''}`
    );
  },
};
