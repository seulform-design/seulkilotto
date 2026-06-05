import { fetchJson } from './fetchJson';

export interface AppMeta {
  ok: boolean;
  source: string;
  current_round: number;
  latest_round: number;
  next_round: number;
  row_count: number;
  gap_count: number;
  is_complete: boolean;
}

export interface LatestDraw {
  round: number;
  draw_date: string;
  numbers: number[];
  bonus: number;
  current_round?: number;
  next_round?: number;
  data_source?: string;
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

export interface FrequencyItem {
  number: number;
  count: number;
  ratio: number;
}

export interface FrequencyResponse {
  total_rounds: number;
  items: FrequencyItem[];
}

export interface GenerateResponse {
  unseen_numbers: number[];
  combinations: GeneratedCombination[];
  warning?: string | null;
}

export type ClassicMethod = 'wilson' | 'gauss' | 'huygens' | 'fermat' | 'blend';

export interface ClassicRecommendResponse {
  next_round: number;
  next_draw_date: string;
  method: string;
  latest_round: number;
  pattern_analysis: Record<string, unknown>;
  combinations: (GeneratedCombination & {
    pattern?: string;
    pattern_label?: string;
  })[];
  warning?: string | null;
  filter_rule: string;
  compose_rule: string;
}

export interface PatternSummary {
  method: string;
  label: string;
  description: string;
  top10?: { number: number }[];
}

export interface PatternsResponse {
  latest_round: number;
  recent_n?: number;
  patterns: Record<string, PatternSummary>;
}

export interface DrawItem {
  round: number;
  draw_date: string;
  numbers: number[];
  bonus: number;
}

export interface RoundsListResponse {
  total: number;
  offset: number;
  limit: number;
  items: DrawItem[];
}

export interface UpgradeStatus {
  ok: boolean;
  source: string;
  latest_round: number;
  current_round: number;
  api_latest_round?: number | null;
  pending_rounds: number[];
  pending_count: number;
  can_upgrade: boolean;
  api_error?: string;
}

export interface UpgradeResult {
  ok: boolean;
  message?: string;
  before_latest: number;
  after_latest: number;
  new_rounds: number;
  updated_rounds: number;
  failed_rounds: number;
  synced_rounds: number[];
  current_round?: number;
  v2_sync?: { ok: boolean; new_rounds?: number; error?: string };
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

export const v1Api = {
  getMeta: () => fetchJson<AppMeta>('/api/v1/meta'),

  getLatestDraw: () => fetchJson<LatestDraw>('/api/v1/history/latest'),

  getFrequency: (recentN?: number) =>
    fetchJson<FrequencyResponse>(
      `/api/v1/stats/frequency${recentN ? `?recent_n=${recentN}` : ''}`
    ),

  analyzeCombination: (numbers: number[]) =>
    fetchJson<CombinationAnalysis>('/api/v1/analyze/combination', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers }),
    }),

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
    return fetchJson<GenerateResponse>(`/api/v1/generate/weights?${q.toString()}`);
  },

  getRoundRecommend: (machine?: 1 | 2 | 3) => {
    const q = new URLSearchParams();
    if (machine) q.set('machine', String(machine));
    const qs = q.toString();
    return fetchJson<RoundRecommendResponse>(
      `/api/v1/recommend/round${qs ? `?${qs}` : ''}`
    );
  },

  getClassicRecommend: (method: ClassicMethod = 'blend') =>
    fetchJson<ClassicRecommendResponse>(
      `/api/v1/recommend/classic?method=${method}`
    ),

  getPatterns: (recentN?: number) =>
    fetchJson<PatternsResponse>(
      `/api/v1/analyze/patterns${recentN ? `?recent_n=${recentN}` : ''}`
    ),

  getUpgradeStatus: () => fetchJson<UpgradeStatus>('/api/v1/data/upgrade-status'),

  runUpgrade: () =>
    fetchJson<UpgradeResult>('/api/v1/data/upgrade', { method: 'POST' }),

  listRounds: (limit = 30, offset = 0) =>
    fetchJson<RoundsListResponse>(
      `/api/v1/history/rounds?limit=${limit}&offset=${offset}`
    ),

  getRound: (round: number) => fetchJson<DrawItem>(`/api/v1/history/${round}`),
};
