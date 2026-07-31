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
  /** 확장망 빌드 스모크(강제 top24). */
  coverage_build?: string;
}

export interface RoundStatus {
  latest_round: number;   // 가장 최근 추첨 완료 회차 (복기 대상)
  current_round: number;  // 다음 추첨 예정 회차 (이번회차)
  review_round: number;   // 복기 탭 기준 회차 (= latest_round)
  drawn: boolean;         // 이번회차 당첨번호 발표 여부 (True 면 CSV 업데이트 필요)
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
  rarity_score?: number | null;
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

export type TemperatureTier = 'hot' | 'warm' | 'neutral' | 'cold' | 'frozen';

export interface TemperatureItem {
  number: number;
  recent_count: number;
  gap: number;
  total_count: number;
  score: number;
  tier: TemperatureTier;
  rank: number;
}

export interface TemperatureResponse {
  lookback: number;
  latest_round: number;
  total_rounds: number;
  items: TemperatureItem[];
  tier_distribution: Record<TemperatureTier, number>;
  tier_labels: Record<TemperatureTier, string>;
  tier_colors: Record<TemperatureTier, string>;
  disclaimer: string;
}

export interface CoOccurrencePartner {
  number: number;
  count: number;
  confidence: number;
  lift: number;
  is_significant: boolean;
}

export interface CoOccurrenceResponse {
  total_rounds: number;
  appearance_counts: Record<string, number>;
  baseline_confidence: number;
  top_n: number;
  /** Key 는 "1"~"45" 문자열, Value 는 상위 N개 동반 번호 */
  partners: Record<string, CoOccurrencePartner[]>;
  disclaimer: string;
}

export type WalkForwardStrategy = 'uniform' | 'frequency' | 'epo' | 'composite';

export interface WalkForwardStrategyResult {
  strategy: WalkForwardStrategy;
  rounds_tested: number;
  sets_generated: number;
  avg_hits_per_set: number;
  hit_distribution: Record<string, number>;
  cumulative_avg: number[];
  rounds_axis: number[];
  hit_rate_3plus: number;
  hit_rate_4plus: number;
  hit_rate_5plus: number;
  hit_rate_6: number;
  delta_vs_baseline: number;
  z_score: number;
  beats_baseline: boolean;
}

export interface WalkForwardResponse {
  start_round: number;
  end_round: number;
  rounds_evaluated: number;
  sets_per_round: number;
  baseline_avg_hits: number;
  strategies: WalkForwardStrategyResult[];
  disclaimer: string;
}

export interface GenerateResponse {
  unseen_numbers: number[];
  combinations: GeneratedCombination[];
  warning?: string | null;
  strategy?: string | null;
  disclaimer?: string | null;
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

export interface MachineHistoryEntry {
  round: number;
  machine: number;
  source: 'confirmed' | 'estimated';
  confirmed: boolean;
}

export interface MachineOverview {
  coverage: { confirmed_count: number; min_round: number; max_round: number };
  latest_round: number;
  latest_machine: number;
  current_block_len: number;
  next_round: number;
  next_draw_date: string;
  next_machine: number;
  next_source: 'confirmed' | 'estimated';
  next_in_rotation: number;
  rotation_order: number[];
  recent_history: MachineHistoryEntry[];
  per_machine: Record<string, { count: number; last_round: number }>;
  note: string;
}

export interface MachineTrait {
  key: string;
  label: string;
  value: number;
  baseline: number;
  unit: string;
  delta: number;
}

export interface MachineProfile {
  machine_id: number;
  confirmed_count: number;
  persona: string;
  tagline: string;
  decade_pct: number[];
  decade_labels: string[];
  hot: { number: number; z: number }[];
  cold: { number: number; z: number }[];
  avg_sum: number;
  avg_odd: number;
  traits: MachineTrait[];
  honesty: string;
}

export interface MachineDrawResult {
  machine_id: number;
  draw_count: number;
  draw_order: number[];
  bonus: number;
  numbers: number[];
  sum_total: number;
  odd_count: number;
  even_count: number;
  signature_numbers: number[];
  avg_sum: number;
  avg_odd: number;
  profile: MachineProfile | null;
  seed: number | null;
  disclaimer: string;
}

export interface RoundRecommendResponse {
  next_round: number;
  next_draw_date: string;
  machine_id: number;
  auto_machine_id: number;
  machine_source?: 'confirmed' | 'estimated' | null;
  machine_data_coverage?: { confirmed_count: number; min_round: number; max_round: number } | null;
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
  combinations: (GeneratedCombination & {
    pattern?: string | null;
    pattern_label?: string | null;
    signal_hits?: number;
  })[];
  top_scored?: {
    number: number;
    score: number;
    decade: number;
    reversion: number;
    gap: number;
  }[];
  backtest?: {
    available: boolean;
    rounds_tested: number;
    top_k: number;
    random_baseline: number;
    new_avg_hits: number;
    new_lift: number;
    new_3plus: number;
    old_avg_hits: number;
    old_lift: number;
    old_3plus: number;
    improvement: number;
  } | null;
  warning?: string | null;
  filter_rule: string;
  compose_rule: string;
}

// ─── EPO 타입 ────────────────────────────────────────────────────────────────
export interface EpoHonestyMeta {
  win_probability_per_set: number;
  win_probability_unchanged: boolean;
  optimization_target: string;
  disclaimer: string;
}

export interface EpoCombination {
  numbers: number[];
  sum_total: number;
  odd_count: number;
  even_count: number;
  high_count: number;
  low_count: number;
  ac_value: number;
  max_consecutive_run: number;
  max_same_decade: number;
  last_digit_unique: number;
  decade_distribution: Record<string, number>;
  last_round_overlap: number;
}

export interface EpoHistoricalProfile {
  rounds_analyzed: number;
  sum_p10: number;
  sum_p50: number;
  sum_p90: number;
  sum_mean: number;
  odd_count_modes: number[];
  high_count_modes: number[];
  avg_ac: number;
  p10_ac: number;
}

export interface EpoBacktestMeta {
  epo_enabled: boolean;
  fallback_active: boolean;
  historical_pass_rate: number;
  pass_threshold: number;
  sample_size: number;
  passed_count: number;
  reason: string;
}

export interface EpoPipelineMeta {
  active_mode: string;
  candidates_attempted: number;
  combinations_returned: number;
  combinations_requested: number;
  filters_applied: string[];
  shortfall_warning: string | null;
}

export interface EpoWeightsMeta {
  lookback_rounds: number;
  hot_bonus: number;
  cold_bonus: number;
  hot_numbers: number[];
  cold_numbers: number[];
}

export interface EpoResponse {
  engine: string;
  combinations: EpoCombination[];
  profile: EpoHistoricalProfile;
  weights: EpoWeightsMeta;
  pipeline: EpoPipelineMeta;
  backtest: EpoBacktestMeta;
  honesty: EpoHonestyMeta;
}

export const v1Api = {
  getMeta: () => fetchJson<AppMeta>('/api/v1/meta'),
  getRoundStatus: () => fetchJson<RoundStatus>('/api/v1/round-status'),

  getLatestDraw: () => fetchJson<LatestDraw>('/api/v1/history/latest'),

  getFrequency: (recentN?: number) =>
    fetchJson<FrequencyResponse>(
      `/api/v1/stats/frequency${recentN ? `?recent_n=${recentN}` : ''}`
    ),

  getTemperature: (lookback = 30) =>
    fetchJson<TemperatureResponse>(`/api/v1/stats/temperature?lookback=${lookback}`),

  getCoOccurrence: (topN = 20) =>
    fetchJson<CoOccurrenceResponse>(`/api/v1/stats/co-occurrence?top_n=${topN}`),

  getWalkForward: (params: {
    startRound?: number;
    endRound?: number;
    setsPerRound?: number;
    includeEpo?: boolean;
    includeComposite?: boolean;
    seed?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.startRound != null) q.set('start_round', String(params.startRound));
    if (params.endRound != null) q.set('end_round', String(params.endRound));
    if (params.setsPerRound != null) q.set('sets_per_round', String(params.setsPerRound));
    if (params.includeEpo) q.set('include_epo', 'true');
    if (params.includeComposite) q.set('include_composite', 'true');
    if (params.seed != null) q.set('seed', String(params.seed));
    return fetchJson<WalkForwardResponse>(`/api/v1/stats/walk-forward?${q.toString()}`, {
      timeoutMs: 60_000,
    });
  },

  analyzeCombination: (numbers: number[]) =>
    fetchJson<CombinationAnalysis>('/api/v1/analyze/combination', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers }),
    }),

  generateSmart: (params: {
    nSets?: number;
    lookback?: number;
    excludeConsecutive?: boolean;
    maxOverlap?: number;
  }) => {
    const q = new URLSearchParams();
    if (params.nSets) q.set('n_sets', String(params.nSets));
    if (params.lookback) q.set('lookback', String(params.lookback));
    if (params.excludeConsecutive !== undefined) {
      q.set('exclude_consecutive', String(params.excludeConsecutive));
    }
    if (params.maxOverlap !== undefined) q.set('max_overlap', String(params.maxOverlap));
    return fetchJson<GenerateResponse>(`/api/v1/generate/smart?${q.toString()}`);
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

  getMachineOverview: () =>
    fetchJson<MachineOverview>('/api/v1/recommend/machine-overview'),

  getMachineProfile: (machine: 1 | 2 | 3) =>
    fetchJson<MachineProfile>(
      `/api/v1/recommend/machine-profile?machine=${machine}`
    ),

  getMachineDraw: (machine: 1 | 2 | 3, seed?: number) => {
    const q = new URLSearchParams({ machine: String(machine) });
    if (seed != null) q.set('seed', String(seed));
    return fetchJson<MachineDrawResult>(`/api/v1/recommend/machine-draw?${q.toString()}`);
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

  getPostOccurrenceAnalysis: (params?: { roundNo?: number; numbers?: number[]; bonus?: number }) => {
    const q = new URLSearchParams();
    if (params?.roundNo) q.set('round_no', String(params.roundNo));
    if (params?.numbers?.length) q.set('numbers', params.numbers.join(','));
    if (params?.bonus != null) q.set('bonus', String(params.bonus));
    const qs = q.toString();
    return fetchJson<PostOccurrenceResponse>(
      `/api/v1/post-occurrence/analysis${qs ? `?${qs}` : ''}`
    );
  },

  analyzeManualSlips: async (
    slips: ManualSlipInput[],
    opts: {
      sheetIntent?: 'review' | 'current_round';
      persist?: boolean;
      /** 이 세트의 픽 타입 — 자동/반자동을 서버에서 분리 저장 */
      pickType?: '자동' | '반자동';
    } = {}
  ) =>
    fetchJson<PhotoAnalysisJobResult>('/api/v1/photo-analysis/manual', {
      method: 'POST',
      timeoutMs: 120_000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sheet_intent: opts.sheetIntent ?? 'current_round',
        pick_type: opts.pickType ?? '반자동',
        persist: opts.persist ?? true,
        allow_duplicate: false,
        slips: slips.map((slip) => ({
          name: slip.name ?? '',
          lines: slip.lines.map((line) => ({
            label: line.label,
            numbers: line.numbers,
          })),
        })),
      }),
    }),

  analyzePhotos: async (
    files: File[],
    opts: { sheetIntent?: 'review' | 'current_round'; persist?: boolean } = {}
  ) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    form.append('sheet_intent', opts.sheetIntent ?? 'current_round');
    form.append('persist', String(opts.persist ?? true));
    form.append('allow_duplicate', 'false');
    return fetchJson<PhotoAnalysisJobResult>('/api/v1/photo-analysis/analyze', {
      method: 'POST',
      body: form,
    });
  },

  getPhotoAnalysisAccumulated: () =>
    fetchJson<PhotoAnalysisAccumulated>('/api/v1/photo-analysis/accumulated'),

  /** 다회차 학습 — 보관 회차 용지 + 실제 당첨으로 지지-적중 캘리브레이션. */
  getRoundLearning: (opts?: { applyIntent?: 'review' | 'current_round' }) => {
    const q = new URLSearchParams();
    if (opts?.applyIntent) q.set('apply_intent', opts.applyIntent);
    const qs = q.toString();
    return fetchJson<RoundLearningResponse>(
      `/api/v1/photo-analysis/round-learning${qs ? `?${qs}` : ''}`,
      { timeoutMs: 60_000 },
    );
  },

  /** 복기 역산 검증 — 당첨번호가 각 신호에서 몇 위였나 + 커버리지 곡선. */
  getReviewVerification: () =>
    fetchJson<ReviewVerificationResponse>('/api/v1/photo-analysis/review-verification', { timeoutMs: 90_000 }),

  /** 줄겹침(2·3·4번호) 패턴 역산 학습 — 보관 회차 겹침 조합 vs 실제 당첨. */
  getOverlapLearning: (opts?: { applyIntent?: 'review' | 'current_round' }) => {
    const q = new URLSearchParams();
    if (opts?.applyIntent) q.set('apply_intent', opts.applyIntent);
    const qs = q.toString();
    return fetchJson<OverlapLearningResponse>(
      `/api/v1/photo-analysis/overlap-learning${qs ? `?${qs}` : ''}`,
      { timeoutMs: 90_000 },
    );
  },

  /** 복기 Feature 자동 생성·검증·학습 — WF/Bootstrap/Permutation/MC + 기여도 추천. */
  getFeatureLearning: (seed = 42, opts?: { applyIntent?: 'review' | 'current_round' }) => {
    const q = new URLSearchParams({ seed: String(seed) });
    if (opts?.applyIntent) q.set('apply_intent', opts.applyIntent);
    return fetchJson<FeatureLearningResponse>(
      `/api/v1/photo-analysis/feature-learning?${q.toString()}`,
      { timeoutMs: 180_000 },
    );
  },

  /** Nested CV — outer top6 hits 리포트 (read-only, scoring_allowed=false). */
  getNestedCv: (seed = 42) =>
    fetchJson<NestedCvResponse>(`/api/v1/photo-analysis/nested-cv?seed=${seed}`, {
      timeoutMs: 180_000,
    }),

  /** Experimental SHAP/Drift proxy — 점수 주입 금지. */
  getShapDrift: (seed = 42) =>
    fetchJson<ShapDriftResponse>(
      `/api/v1/photo-analysis/experimental/shap-drift?seed=${seed}`,
      { timeoutMs: 180_000 },
    ),

  /** Statistics Artifact 스냅샷 — 점수 미연결. */
  getStatisticsSnapshot: (opts?: { recentN?: number; persist?: boolean; includeCarry?: boolean }) => {
    const q = new URLSearchParams();
    if (opts?.recentN != null) q.set('recent_n', String(opts.recentN));
    if (opts?.persist) q.set('persist', 'true');
    if (opts?.includeCarry) q.set('include_carry', 'true');
    const qs = q.toString();
    return fetchJson<StatisticsSnapshot>(
      `/api/v1/stats/snapshot${qs ? `?${qs}` : ''}`,
      { timeoutMs: 60_000 },
    );
  },

  getStatisticsSnapshotHistory: (limit = 30) =>
    fetchJson<StatisticsSnapshotHistory>(
      `/api/v1/stats/snapshot/history?limit=${limit}`,
      { timeoutMs: 30_000 },
    ),

  getStatisticsSnapshotFile: (filename: string) =>
    fetchJson<StatisticsSnapshot>(
      `/api/v1/stats/snapshot/history/${encodeURIComponent(filename)}`,
      { timeoutMs: 30_000 },
    ),

  /** Model Registry — 사람 승인 비활성 목록. */
  getModelRegistry: () =>
    fetchJson<ModelRegistryState>('/api/v1/photo-analysis/model-registry'),

  postModelRegistryDisable: (
    body: { model_id: string; reason?: string; confirm: boolean; by?: string },
    upgradeKey?: string,
  ) =>
    fetchJson<ModelRegistryActionResult>('/api/v1/photo-analysis/model-registry/disable', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(upgradeKey ? { 'X-Upgrade-Key': upgradeKey } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    }),

  postModelRegistryEnable: (
    body: { model_id: string; reason?: string; confirm: boolean; by?: string },
    upgradeKey?: string,
  ) =>
    fetchJson<ModelRegistryActionResult>('/api/v1/photo-analysis/model-registry/enable', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(upgradeKey ? { 'X-Upgrade-Key': upgradeKey } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    }),

  /** 복기 Pattern Mining — 전수 학습·검증·Cluster·설명가능 추천. */
  getPatternMining: (seed = 42, opts?: { applyIntent?: 'review' | 'current_round' }) => {
    const q = new URLSearchParams({ seed: String(seed) });
    if (opts?.applyIntent) q.set('apply_intent', opts.applyIntent);
    return fetchJson<PatternMiningResponse>(
      `/api/v1/photo-analysis/pattern-mining?${q.toString()}`,
      { timeoutMs: 180_000 },
    );
  },

  /** 복기 이월(carryover) 역산 — '강수 미당첨 → 다음 회차 당첨' 검증 + 이번회차 이월 후보. */
  getCarryoverLearning: (seed = 42) =>
    fetchJson<CarryoverLearningResponse>(
      `/api/v1/photo-analysis/carryover-learning?seed=${seed}`,
      { timeoutMs: 120_000 },
    ),

  /** 전체 당첨 이력 워크포워드 백테스트 — 흔한 전략이 무작위를 이기나(다중검정 보정). */
  getFullHistoryBacktest: () =>
    fetchJson<FullHistoryBacktestResponse>(
      '/api/v1/photo-analysis/full-history-backtest',
      { timeoutMs: 60_000 },
    ),

  /** 복기 엔트리 회차 재귀속(관리자) — 라벨만 교정, 보관 정본 불변, 원본 회차 보존. */
  reattributeEntries: (fromRound: number, toRound: number, entryIds?: string[]) =>
    fetchJson<{
      ok: boolean;
      changed: number;
      from_round: number;
      to_round: number;
      note?: string;
      accumulated?: PhotoAnalysisAccumulated;
    }>('/api/v1/photo-analysis/reattribute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_round: fromRound, to_round: toRound, entry_ids: entryIds ?? null }),
      timeoutMs: 60_000,
    }),

  getPredictionSignals: (
    intent: 'review' | 'current_round' = 'current_round',
    seed?: number,
    targetRound?: number,
  ) => {
    const q = new URLSearchParams({ intent });
    if (seed != null) q.set('seed', String(seed));
    if (targetRound != null && Number.isFinite(targetRound) && targetRound > 0) {
      q.set('target_round', String(targetRound));
    }
    return fetchJson<PredictionSignalsResponse>(`/api/v1/prediction/signals?${q.toString()}`, {
      timeoutMs: 60_000,
    });
  },

  getParallelRoundAnalysis: (targetRound?: number) => {
    const q = new URLSearchParams();
    if (targetRound != null) q.set('target_round', String(targetRound));
    const qs = q.toString();
    return fetchJson<ParallelRoundAnalysisResponse>(
      `/api/v1/analysis/parallel-round${qs ? `?${qs}` : ''}`
    );
  },

  getPhotoVisionConfig: () =>
    fetchJson<{
      configured: boolean;
      has_api_key?: boolean;
      use_vision_api?: boolean;
      analysis_mode?: string;
      model: string;
      env_hint: string;
    }>('/api/v1/photo-analysis/vision-config'),

  savePhotoVisionConfig: (apiKey: string, model = 'gpt-4o-mini') =>
    fetchJson<{ ok: boolean; configured: boolean; use_vision_api?: boolean; model: string; message: string }>(
      '/api/v1/photo-analysis/vision-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, model }),
      }
    ),

  disablePhotoVisionConfig: () =>
    fetchJson<{ ok: boolean; configured: boolean; use_vision_api: boolean; message: string }>(
      '/api/v1/photo-analysis/vision-config',
      { method: 'DELETE' }
    ),

  clearPhotoAnalysisStore: (
    intent?: 'review' | 'current_round',
    pickType?: '자동' | '반자동',
    opts?: { roundNo?: number },
  ) => {
    const q = new URLSearchParams();
    if (intent) q.set('intent', intent);
    if (pickType) q.set('pick_type', pickType);
    if (opts?.roundNo != null) q.set('round_no', String(opts.roundNo));
    const qs = q.toString();
    return fetchJson<{ ok: boolean; removed: number }>(
      `/api/v1/photo-analysis/store${qs ? `?${qs}` : ''}`,
      { method: 'DELETE' },
    );
  },

  deletePhotoAnalysisEntry: (entryId: string) =>
    fetchJson<{ ok: boolean; accumulated: PhotoAnalysisAccumulated }>(
      `/api/v1/photo-analysis/store/${entryId}`,
      { method: 'DELETE' }
    ),


  generateEpo: (params: {
    nSets?: number;
    lookback?: number;
    hotBonus?: number;
    coldBonus?: number;
    sumMin?: number;
    sumMax?: number;
    maxConsecutiveRun?: number;
    minAcValue?: number;
    maxSameDecade?: number;
    minLastDigitUnique?: number;
    maxLastRoundOverlap?: number;
    interSetMaxOverlap?: number;
    enableBacktest?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params.nSets) q.set('n_sets', String(params.nSets));
    if (params.lookback) q.set('lookback', String(params.lookback));
    if (params.hotBonus != null) q.set('hot_bonus', String(params.hotBonus));
    if (params.coldBonus != null) q.set('cold_bonus', String(params.coldBonus));
    if (params.sumMin != null) q.set('sum_min', String(params.sumMin));
    if (params.sumMax != null) q.set('sum_max', String(params.sumMax));
    if (params.maxConsecutiveRun != null) q.set('max_consecutive_run', String(params.maxConsecutiveRun));
    if (params.minAcValue != null) q.set('min_ac_value', String(params.minAcValue));
    if (params.maxSameDecade != null) q.set('max_same_decade', String(params.maxSameDecade));
    if (params.minLastDigitUnique != null) q.set('min_last_digit_unique', String(params.minLastDigitUnique));
    if (params.maxLastRoundOverlap != null) q.set('max_last_round_overlap', String(params.maxLastRoundOverlap));
    if (params.interSetMaxOverlap != null) q.set('inter_set_max_overlap', String(params.interSetMaxOverlap));
    if (params.enableBacktest != null) q.set('enable_backtest', String(params.enableBacktest));
    return fetchJson<EpoResponse>(`/api/v1/generate/epo?${q.toString()}`, {
      timeoutMs: 60_000,
    });
  },
};

export interface ManualSlipInput {
  name?: string;
  lines: { label: string; numbers: number[] }[];
}

export interface PhotoAnalysisJobResult {
  result: PhotoAnalysisResponse;
  stored_entry_id: string | null;
  accumulated: PhotoAnalysisAccumulated | null;
  duplicate_skipped?: boolean;
  duplicate_reason?: string;
  duplicate_message?: string;
  analysis_skipped?: boolean;
  duplicates_removed?: number;
}

export interface PhotoAnalysisResponse {
  video_visual_analysis: {
    detected_round: string | null;
    ticket_round?: string | null;
    ticket_round_confidence?: string;
    video_intent?: string;
    video_intent_label?: string;
    referenced_rounds?: string[];
    current_round_ref?: number;
    main_board_summary: string;
    video_title?: string;
    video_id?: string;
  };
  extracted_visual_patterns: {
    identified_multiples: { type: string; numbers: number[] };
    frequency_overlap_patterns?: FrequencyOverlapPatterns;
    triple_plus_overlap?: {
      pattern_label: string;
      items: FrequencyOverlapItem[];
    };
    combo_patterns?: ComboDuplicatePatterns;
    pattern_application?: PatternApplication;
    draw_template?: DrawReviewTemplate | null;
    draw_analysis?: PatternApplication;
    photo_review_template?: SavedReviewTemplate;
    review_reference_template?: SavedReviewTemplate;
    line_patterns: { target_number: number; pattern_type: string }[];
  };
  final_predictions: {
    strong_candidates: number[];
    excluded_candidates: number[];
  };
  app_ui_message: string;
  meta?: {
    images_analyzed?: number;
    duplicates_removed?: number;
    image_names?: string[];
    sheet_intent?: string;
    sheet_intent_label?: string;
    review_round_ref?: number;
    current_round_ref?: number;
    preview_image_base64?: string | null;
    analysis_mode?: string;
    vision_error?: string | null;
    ocr_numbers_detected?: number;
    has_transcript?: boolean;
    text_numbers_from_meta?: number[];
  };
}

export interface VideoVoteItem {
  number: number;
  votes: number;
  video_count: number;
}

export interface FrequencyOverlapItem {
  number: number;
  overlap_count?: number;
  video_votes?: number;
  votes?: number;
  max_overlap_count?: number;
}

export interface FrequencyOverlapTier {
  min_count: number;
  label: string;
  pattern_type: string;
  number_count?: number;
  items: FrequencyOverlapItem[];
}

export interface FrequencyOverlapPatterns {
  summary: string;
  all_frequent: FrequencyOverlapItem[];
  tiers: FrequencyOverlapTier[];
  triple_plus_overlap?: {
    pattern_label: string;
    items: FrequencyOverlapItem[];
  };
}

export type TriplePlusOverlapItem = FrequencyOverlapItem;

export interface ComboDuplicateItem {
  numbers: number[];
  size: number;
  repeat_count: number;
  line_count?: number;
  expected?: number;
  lift?: number;
  z?: number;
  label: string;
  sheet_indices?: number[];
}

export interface ComboVerification {
  sheets_analyzed: number;
  physical_sheets_detected?: number;
  images_uploaded?: number;
  lines_analyzed?: number;
  avg_marks_per_sheet?: number;
  avg_marks_per_line?: number;
  pair_min_repeat: number;
  triple_min_repeat: number;
  quad_min_repeat?: number;
  raw_pair_candidates?: number;
  raw_triple_candidates?: number;
  raw_quad_candidates?: number;
  significant_pairs: number;
  significant_triples: number;
  significant_quads?: number;
  same_line_tier_counts?: Record<string, number>;
  criteria: string;
}

export interface SameLineMatch {
  sheet_index: number;
  line_index: number;
  line_label: string;
  line_id?: string;
  line_numbers: number[];
  overlap_count: number;
  matching_numbers: number[];
  prize_tier: string;
  source_image?: string;
}

export interface CrossLineSetItem {
  numbers: number[];
  size: number;
  appearance_count?: number;
  line_count?: number;
  repeat_count?: number;
  locations?: string[];
  image_indices?: number[];
}

export interface CrossLineAnalysisReport {
  triple_sets: CrossLineSetItem[];
  pair_sets: CrossLineSetItem[];
  summary_opinion: string;
  min_repeat: number;
  line_count: number;
  image_count: number;
  line_label_counts?: Record<string, number>;
  formatted_text?: string;
  sections?: {
    triples: string;
    pairs: string;
    summary: string;
  };
}

export interface ComboDuplicatePatterns {
  summary: string;
  sheet_count: number;
  line_count?: number;
  analysis_mode?: string;
  reference_numbers?: number[];
  min_repeat: number;
  combo_verification?: ComboVerification;
  same_line_matches?: SameLineMatch[];
  same_line_by_tier?: Record<string, SameLineMatch[]>;
  cross_line_combos?: ComboDuplicateItem[];
  cross_line_analysis?: CrossLineAnalysisReport;
  pair_duplicates: ComboDuplicateItem[];
  triple_duplicates: ComboDuplicateItem[];
  quad_duplicates?: ComboDuplicateItem[];
  strong_candidates?: number[];
}

export interface PatternApplication {
  summary: string;
  review_round?: string;
  review_rounds?: string[];
  review_numbers?: number[];
  position_match_numbers?: number[];
  number_only_matches?: number[];
  combo_hits?: {
    numbers: number[];
    size: number;
    review_repeat?: number;
    current_sheet_hits: number;
    sheet_indices: number[];
  }[];
}

export interface DrawReviewTemplate {
  source?: string;
  ticket_round?: string;
  ticket_rounds?: string[];
  winning_numbers: number[];
  bonus?: number;
  marked_numbers: number[];
  positions: Record<string, { row: number; col: number }>;
  summary?: string;
  winning_combo_reference?: {
    pair_combos: { numbers: number[] }[];
    triple_combos: { numbers: number[] }[];
    pair_count: number;
    triple_count: number;
  };
  combo_patterns?: ComboDuplicatePatterns;
}

export interface SavedReviewTemplate extends DrawReviewTemplate {
  source_count?: number;
  official_draw?: DrawReviewTemplate;
}

export interface PhotoAnalysisIntentSlice {
  video_intent: 'review' | 'current_round';
  video_intent_label: string;
  ticket_round?: string;
  total_analyses: number;
  accumulated_combo_patterns?: ComboDuplicatePatterns;
  final_predictions?: {
    strong_candidates: number[];
    excluded_candidates: number[];
  };
  saved_review_template?: SavedReviewTemplate | null;
  draw_template?: DrawReviewTemplate;
  pattern_ready?: boolean;
  entries_summary: PhotoAnalysisAccumulated['entries_summary'];
  /** 서버에 저장된 반자동 게임 줄(번호배열) — 기기 간 동기화 복원용. */
  saved_semi_lines?: number[][];
  /** 서버에 저장된 자동 게임 줄(번호배열) — 기기 간 동기화 복원용. */
  saved_auto_lines?: number[][];
  /**
   * 복기 전용 — 이 회차 데이터가 어느 출처에서 왔는지.
   * archived=롤오버 보관 정본(추첨 전 등록, 소속 확실) / review_saved=복기 탭 저장분.
   */
  round_sources?: {
    primary: 'archived' | 'review_saved' | 'legacy_all';
    archived_entries: number;
    archived_auto_lines: number;
    archived_semi_lines: number;
    review_saved_entries: number;
    review_saved_auto_lines: number;
    review_saved_semi_lines: number;
  };
  app_ui_message: string;
}

export interface ArchivedCurrentRoundSnapshot {
  archived: true;
  ticket_round?: string | null;
  round_no: number;
  total_analyses: number;
  final_predictions: {
    strong_candidates: number[];
    excluded_candidates: number[];
  };
  /** 통합 신호(6소스) 강한후보 — 라이브=백테스트 일원화. 구버전 보관본엔 없음. */
  unified_strong_candidates?: number[];
  unified_excluded_candidates?: number[];
  /** 롤오버로 보관된 '그 회차 이번회차 용지' 줄 — 추첨 후 복기에서 보기 위함. */
  saved_auto_lines?: number[][];
  saved_semi_lines?: number[][];
  accumulated_combo_patterns?: ComboDuplicatePatterns;
  entries_summary: PhotoAnalysisAccumulated['entries_summary'];
  app_ui_message: string;
  frozen_at?: string | null;
  merged_at?: string | null;
  backtest?: {
    round_no?: number;
    winning_numbers?: number[];
    bonus?: number;
    engine_results?: Record<string, {
      combo_count?: number;
      best_hit?: number;
      bonus_hits?: number;
      hit_distribution?: Record<string, number>;
      strong_hits?: number[];
      excluded_hits?: number[];
      bonus_in_strong?: boolean;
      bonus_in_excluded?: boolean;
    }>;
  };
}

/** 복기 역산 검증 — 당첨번호가 각 신호에서 몇 위였나 + 커버리지 곡선. */
/** 이항 정규근사 유의성 — 관측 hits/trials 가 무작위 기준확률을 우연 이상으로 초과하나. */
export interface BinomialSignificance {
  hits: number;
  trials: number;
  expected: number;
  rate: number;
  ci95: [number, number];
  z: number;
  p_value: number;
  lift: number;
  /** 소표본(회차/전이 적음)이면 유의해 보여도 우연 가능 → significant 를 보수적으로 억제. */
  significant: boolean;
  small_sample: boolean;
}

/** 커버리지가 균등무작위를 유의하게 초과하나 — 회차별 초기하 합의 정규근사 검정. */
export interface CoverageSignificance {
  total_hits: number;
  expected: number;
  mean_hit: number;
  ci95: [number, number];
  z: number;
  p_value: number;
  lift: number;
  /** 소표본이면 유의해 보여도 우연 가능 → significant 를 보수적으로 False 억제. */
  significant: boolean;
  small_sample: boolean;
}

/** 넓은 그물(expand18)의 구간(10단위) 균형 진단. */
export interface DecadeBalance {
  /** 보정 세트의 구간별 개수. */
  spread: Record<string, number>;
  /** 보정 전 상위18이 놓쳤다가 보정으로 채운 구간. */
  filled_decades: string[];
  /** 티켓에 후보가 아예 없는(구조적 미포착) 구간. */
  empty_decades: string[];
  /** 구간균형이 raw top18에서 밀어낸 번호 */
  displaced?: number[];
  /** 구간균형이 새로 올린 번호 */
  promoted?: number[];
}

export interface ReviewVerificationResponse {
  ok: boolean;
  reason?: string;
  round_no: number;
  winning_numbers?: number[];
  auto_line_count?: number;
  semi_line_count?: number;
  signals?: {
    key: string;
    label: string;
    winner_ranks: { number: number; rank: number }[];
    coverage: Record<string, number>;
    top6_numbers: number[];
  }[];
  best_signal_key?: string;
  current_round_no?: number;
  review_fixed_semi?: number[];
  current_fixed_semi?: number[];
  /** 복기 회차 용지 기준 커버리지 (당첨 대조용). 이번회차 세트와 분리. */
  review_coverage_set?: {
    signal: string;
    signal_label: string;
    selected_by?: 'multi_round' | 'single_round';
    core6: number[];
    expand18: number[];
    expand_size?: number;
    expand18_mode?: string;
    expand18_mode_label?: string;
    expand18_precision?: number[];
    expand18_raw?: number[];
    expand18_single?: number[];
    expand18_boe_balanced?: number[];
    decade_balance?: DecadeBalance;
    excluded_signals?: string[];
  };
  /** 복기 회차 다중신호 합의 커버리지. */
  review_consensus_coverage?: {
    good_signal_count?: number;
    good_signals?: string[];
    core6?: number[];
    expand18?: number[];
    agreement?: Record<string, number>;
    need?: number;
    decade_balance?: DecadeBalance;
  };
  /** 복기 추천 vs 당첨 — 티켓 천장·확장망 밖 당첨 감사. */
  review_hit_audit?: {
    winning: number[];
    /** @deprecated UI 라벨 금지 — on_ticket 사용 */
    catchable: number[];
    /** @deprecated UI 라벨 금지 — missing_ticket 사용 */
    uncatchable: number[];
    catchable_count: number;
    on_ticket?: number[];
    missing_ticket?: number[];
    on_ticket_count?: number;
    core6_hit: number[];
    expand18_hit: number[];
    core6_count: number;
    expand18_count: number;
    expand_size?: number;
    expand18_precision_count?: number;
    /** 용지에는 있으나 확장망 순위 밖인 당첨 */
    outside_expand?: number[];
    /** @deprecated outside_expand 와 동일(하위호환) */
    missed_catchable: number[];
    missed_detail?: {
      number: number;
      single_rank?: number;
      boe_rank?: number;
      in_raw_expand?: boolean;
      in_single_expand?: boolean;
    }[];
    random_expect_core6: number;
    random_expect_expand18: number;
    vs_random_expand?: number;
    ceiling_note?: string;
  };
  coverage_build?: string;
  /** expand18 구성 모드 LOO walk-forward. */
  expand_walkforward?: {
    ok: boolean;
    selected_mode: string;
    selected_size?: number;
    selected_label?: string;
    rounds: number;
    random_baseline: number;
    means?: Record<string, number>;
    means_by_size?: Record<string, number>;
    size_lift_24_vs_18?: number;
    beats_random?: boolean;
    beats_legacy_boe_balanced?: boolean;
    legacy_boe_balanced_mean?: number;
    selected_mean?: number;
    reason?: string;
  };
  current_coverage_set?: {
    signal: string;
    signal_label: string;
    selected_by?: 'multi_round' | 'single_round';
    core6: number[];
    expand18: number[];
    expand_size?: number;
    expand18_mode?: string;
    expand18_mode_label?: string;
    expand18_precision?: number[];
    expand18_raw?: number[];
    expand18_single?: number[];
    expand18_boe_balanced?: number[];
    decade_balance?: DecadeBalance;
    excluded_signals?: string[];
  };
  /** 이번회차 다중신호 합의 커버리지 — 검증 통과 신호들이 함께 가리키는 번호. */
  consensus_coverage?: {
    good_signal_count?: number;
    good_signals?: string[];
    core6?: number[];
    expand18?: number[];
    agreement?: Record<string, number>;
    need?: number;
    decade_balance?: DecadeBalance;
  };
  /** 구간(10단위)별 당첨 커버리지 진단 — 어느 구간이 덜 잡혔나(복기 회차 집계). */
  decade_catch?: {
    rounds: number;
    per_decade: { decade: string; winning: number; caught_top18: number; catch_rate: number | null }[];
    weak_decades: string[];
  };
  /** 앙상블 커버리지 천장 백테스트 — 전 엔진 신호를 합쳐도 무작위를 이기나(정직한 천장). */
  ensemble_backtest?: {
    ok: boolean;
    reason?: string;
    rounds: number;
    small_sample?: boolean;
    ensemble_method?: string;
    signals_combined?: string[];
    per_round?: { round_no: number; winning: number[]; ens_top6: number; ens_top18: number }[];
    ensemble_mean?: Record<string, number>;
    ensemble_significance?: Record<string, CoverageSignificance>;
    best_single_signal?: { label: string; mean_top18: number } | null;
    random_baseline?: { top6: number; top18: number };
    beats_random?: boolean;
    beats_best_single?: boolean;
    verdict?: string;
    honesty?: string;
  };
  /** 놓친 당첨 분석 — 어떤 신호로도 못 잡은 당첨(예측 천장). */
  missed_winner_analysis?: {
    rounds: number;
    aggregate: {
      total: number;
      top6_any: number;
      top18_any: number;
      top30_any: number;
      uncatchable: number;
      missing_ticket: number;
    };
    per_round?: {
      round_no: number;
      winning: number[];
      caught_top18: number[];
      missed: { number: number; best_rank: number; in_ticket: boolean }[];
    }[];
  };
  /** 다회차 신호 순위표 — 어느 신호가 당첨을 가장 잘 잡았나(고정수 제외). */
  signal_leaderboard?: {
    rounds: number;
    small_sample?: boolean;
    best_signal_multi?: string | null;
    random_baseline?: { top6: number; top18: number };
    underperforming_keys?: string[];
    leaderboard?: {
      key: string;
      label: string;
      mean_top6: number;
      mean_top18: number;
      tiers: { t6: number; t18: number; t30: number; out: number };
      significance?: CoverageSignificance;
      underperforming?: boolean;
      beats_random18?: boolean;
    }[];
    /** Leave-One-Out 교차검증 — 신호 선택이 일반화되나(과적합 아닌지). */
    loo?: {
      folds: { held_round: number; chosen_signal: string; chosen_label: string; top18_hit: number }[];
      mean_top18_hit: number | null;
      random_baseline: number;
      generalizes: boolean;
    };
  };
  /** 시니어/디렉터 역산 진단 — 낮은 당첨률 원인 → 주입·추천 정책. */
  inverse_diagnosis?: {
    problems: { id: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string }[];
    actions: string[];
    verdict: string;
    metrics?: {
      best_signal?: string | null;
      best_label?: string | null;
      mean_top6?: number;
      mean_top18?: number;
      random_top6?: number;
      random_top18?: number;
      support_top6_mean?: number;
      support_top18_mean?: number;
      ticket_miss_pct?: number;
      top6_any_pct?: number;
      top18_any_pct?: number;
      underperforming?: string[];
      small_sample?: boolean;
      loo_generalizes?: boolean;
    };
    policy?: {
      coverage_mode: 'expand18_first' | 'balanced';
      core6_weight_scale: number;
      expand18_weight_scale: number;
      multi_round_confidence: number;
      /** @deprecated 합의 희석 실증 후 항상 false. core6_mode/expand18_mode 사용. */
      prefer_consensus: boolean;
      /** 핵심6: best_single(다회차 1위) | consensus(폴백만) */
      core6_mode?: 'best_single' | 'consensus';
      /** 확장망: best_of_engines(min-rank) | consensus | merge_recall */
      expand18_mode?: 'best_of_engines' | 'consensus' | 'merge_recall' | string;
      /** WF가 고른 세부 구성(merge_raw, boe_balanced 등) */
      expand18_variant?: string;
      expand18_variant_label?: string;
      expand_size?: number;
      banned_signals: string[];
      preferred_signal?: string | null;
    };
  };
  /** 다회차 백테스트 — 보관 전 회차의 지지(고정수 제외) 상위 K 커버리지 + 이월. */
  multi_round_backtest?: {
    rounds: number;
    small_sample?: boolean;
    aggregate?: Record<string, { mean_hit: number; mean_exp: number; lift: number; significance?: CoverageSignificance }>;
    per_round?: {
      round_no: number;
      winning: number[];
      auto_lines: number;
      semi_lines: number;
      fixed_semi: number[];
      semi_repeat_top?: { number: number; frac: number }[];
      support_coverage: Record<string, number>;
      carryover: { to_round: number; hit: number; pool: number; carried: number[] } | null;
    }[];
  };
  summary?: { best_top6: number; best_top18: number; best_label: string | null };
  honesty?: string;
  /** Explain Artifact 표준 스키마 (artifacts/10_explain/SCHEMA.md). */
  explain?: ExplainPayload;
}

/** Explain Artifact — 엔진 공통 페이로드. */
export interface ExplainPayload {
  version: string;
  subject: { type: string; value: string | number | null };
  decision: string;
  confidence: {
    overall: number;
    statistics: number;
    pattern: number;
    model: number;
    simulation: number;
    backtest: number;
  };
  evidence: { kind: string; detail: string; weight: number }[];
  used_data: { intent: string; rounds: number[]; artifact_versions: string[] };
  algorithms: string[];
  backtest: { metric: string; value: number | null; baseline: number | null; small_sample: boolean };
  limits: string[];
  improvements: string[];
  honesty: string;
  /** true 이면 Experimental 배너 — decision과 무관, 점수 미연결. */
  experimental?: boolean;
}

/** Validation Gate 응답 요약 (artifacts/08_ai/validation_gate.md). */
export interface ValidationGatesSummary {
  version?: string;
  passed: string[];
  rejected: string[];
  scoring_allowed_ids: string[];
  demo_blocked: boolean;
  count: number;
}

export interface GateResult {
  version?: string;
  model_id: string;
  status: string;
  scoring_allowed: boolean;
  checks?: { id: string; ok: boolean; detail: string }[];
  metrics?: Record<string, number | boolean | null>;
  honesty?: string;
  at?: string;
}

/** 줄겹침(2·3·4번호) 역산 학습 — 겹침 조합이 실제 당첨을 얼마나 담았는지. */
export interface OverlapLearningResponse {
  ok: boolean;
  reason?: string;
  round_count: number;
  total_combos?: number;
  rounds?: {
    round_no: number;
    winning_numbers: number[];
    auto_line_count: number;
    combo_count: number;
    by_size: { size: number; combos: number; mean_overlap: number; expected: number; lift_vs_chance: number; fully_winning: number }[];
  }[];
  by_size?: { size: number; combos: number; mean_overlap: number; expected: number; lift_vs_chance: number; fully_winning: number }[];
  by_lift_bucket?: { size: number; bucket: string; combos: number; mean_overlap: number; expected: number; lift_vs_chance: number }[];
  current_round_no?: number;
  apply_intent?: 'review' | 'current_round';
  apply_label?: string;
  apply_source?: string;
  current_combo_count?: number;
  current_scores?: { number: number; score: number; combo_support: number }[];
  calibration_flat?: boolean;
  /** 신호 정면비교(회차 평균) — 사용자 가설(조합강도)이 단순 빈도(support)를 이기나? */
  signal_comparison?: {
    rounds: number;
    signals?: { key: string; label: string; mean_top6: number; mean_top10: number; mean_top18: number }[];
    random_baseline?: { top6: number; top10: number; top18: number };
    verdict?: string;
  };
  honesty?: string;
  explain?: ExplainPayload;
}

/** 전체 당첨 이력 워크포워드 백테스트 — 흔한 전략이 무작위를 이기나(다중검정 보정). */
export interface FullHistoryBacktestResponse {
  ok: boolean;
  reason?: string;
  total_rounds: number;
  tested_rounds?: number;
  warmup?: number;
  random_baseline?: Record<string, number>;
  strategies?: {
    strategy: string;
    label: string;
    by_k: Record<string, {
      hits: number;
      mean_per_round: number;
      expected_per_round: number;
      lift: number;
      p_value: number;
      significant_raw: boolean;
      significant: boolean;
    }>;
  }[];
  multiple_testing?: {
    n_tested: number;
    alpha: number;
    expected_false_positives: number;
    bonferroni_alpha: number;
    raw_significant_count: number;
    note?: string;
  };
  any_beats_random?: boolean;
  verdict?: string;
  honesty?: string;
}

/** 복기 이월(carryover) 역산 — '강수 미당첨 → 다음 회차 당첨' 검증 + 이번회차 이월 후보. */
export interface CarryoverLearningResponse {
  ok: boolean;
  reason?: string;
  round_count: number;
  from_round?: number;
  backtest?: {
    pairs: number;
    by_k?: Record<string, { hit: number; exp: number; lift: number; pairs: number; significance?: BinomialSignificance }>;
    per_pair?: {
      from_round: number;
      to_round: number;
      by_k: Record<string, { pool: number; hit: number; exp: number; lift: number; carried: number[] }>;
    }[];
  };
  calibration_flat?: boolean;
  current_candidates?: { number: number; prev_support_rank: number; score: number }[];
  baselines?: { uniform_hit_rate: number };
  honesty?: string;
}

/** 복기 Feature 자동 생성·검증·학습 엔진 응답. */
export interface FeatureLearningFeatureReport {
  key: string;
  label: string;
  adopted: boolean;
  reproducible: boolean;
  walk_forward_mean_hits: number;
  walk_forward_hits: number[];
  bootstrap_mean: number;
  bootstrap_ci95: [number, number];
  permutation_p: number;
  monte_carlo_baseline: { mean: number; ci95: [number, number] };
  uniform_baseline: number;
  lift_vs_uniform: number;
  lift_vs_monte_carlo: number;
  time_split: { early_mean: number; late_mean: number };
  validation_passed: boolean;
  use_reason: string[];
  exclude_reason: string[];
  last_gate?: GateResult;
  /** 사람 승인 Model Registry disable 로 scoring 강제 차단. */
  human_disabled?: boolean;
}

export interface StatisticsSnapshot {
  version?: string;
  artifact_id?: string;
  created_at?: string;
  honesty?: string;
  note?: string;
  persist?: { ok?: boolean; filename?: string; persisted_at?: string };
  source?: {
    dataset?: string;
    rounds?: { from?: number; to?: number; count?: number };
  };
  empirical?: {
    sum?: { p01?: number; p10?: number; p50?: number; p90?: number; p99?: number; mean?: number };
    odd_count_modes?: number[];
    high_count_modes?: number[];
    ac?: { mean?: number; p10?: number };
  };
  decade_bands?: {
    labels?: string[];
    hit_rate_per_band?: number[];
    expected_per_band?: number[];
    note?: string;
  };
  baselines?: {
    uniform_hit_prob?: number;
    uniform_top6_hits?: number;
    jackpot_odds?: string;
  };
  [key: string]: unknown;
}

export interface StatisticsSnapshotHistoryItem {
  filename: string;
  size_bytes?: number;
  mtime?: string;
  version?: string;
  rounds_count?: number;
  created_at?: string;
  parse_error?: boolean;
}

export interface StatisticsSnapshotHistory {
  ok: boolean;
  count?: number;
  total_files?: number;
  items?: StatisticsSnapshotHistoryItem[];
  honesty?: string;
}

export interface ModelRegistryState {
  disabled_ids?: string[];
  event_count?: number;
  auto_mutate_scoring?: boolean;
  honesty?: string;
  disabled?: Record<string, { reason?: string; at?: string; by?: string }>;
  events?: { action?: string; model_id?: string; at?: string; reason?: string }[];
}

export interface ModelRegistryActionResult {
  ok: boolean;
  error?: string;
  model_id?: string;
  auto_applied?: boolean;
  disabled_ids?: string[];
}

export interface FeatureLearningResponse {
  ok: boolean;
  reason?: string;
  round_count: number;
  current_round_no?: number;
  adopted_count?: number;
  rejected_count?: number;
  dataset?: {
    rounds: { round_no: number; auto_lines: number; semi_lines: number; winning: number[] }[];
    feature_count: number;
    sample_rows: number;
    sources: string[];
    excluded_sources: string[];
  };
  features?: FeatureLearningFeatureReport[];
  ensemble?: {
    ok: boolean;
    reason?: string;
    models: {
      name: string;
      walk_forward_mean_hits: number;
      walk_forward_hits: number[];
      folds: number;
      lift_vs_uniform: number;
      permutation_importance: Record<string, number>;
      stable: boolean;
    }[];
    selected: string | null;
    note?: string;
  };
  recommendation?: {
    ok: boolean;
    reason?: string;
    source?: string;
    adopted_feature_count?: number;
    adopted_features?: { key: string; label: string; lift: number }[];
    numbers?: {
      number: number;
      score: number;
      contributions: {
        feature: string;
        label: string;
        contribution: number;
        raw_value: number;
        weight: number;
      }[];
    }[];
    top6?: number[];
    honesty?: string;
  };
  baselines?: { uniform_top6_hits: number; uniform_hit_rate: number };
  pipeline?: string[];
  honesty?: string;
  explain?: ExplainPayload;
  validation_gates?: ValidationGatesSummary;
  orchestrator?: {
    version?: string;
    candidates?: {
      model_id: string;
      action: string;
      reason: string;
      requires_human?: boolean;
      auto_applied?: boolean;
    }[];
    unchanged?: string[];
    auto_mutate_scoring?: boolean;
    honesty?: string;
  };
  model_registry?: {
    disabled_ids?: string[];
    event_count?: number;
    auto_mutate_scoring?: boolean;
    honesty?: string;
  };
}

/** Nested CV 리포트 — Gate·승인 전 scoring 금지. */
export interface NestedCvPickedModel {
  outer_test_index: number;
  outer_round_no: number;
  train_rounds: number[];
  adopted_count: number;
  mean_lift_vs_uniform: number;
  picked: string[];
  top6: number[];
  top6_hits: number;
  winning: number[];
}

export interface NestedCvResponse {
  version?: string;
  ok: boolean;
  experimental?: boolean;
  outer_folds?: number;
  inner_folds?: number;
  mean_top6?: number | null;
  baseline_top6?: number;
  lift_vs_uniform?: number | null;
  lift_vs_baseline_hits?: number | null;
  small_sample?: boolean;
  picked_models?: NestedCvPickedModel[];
  scoring_allowed: boolean;
  honesty?: string;
  note?: string;
  reason?: string;
  run_at?: string;
}

/** Experimental SHAP/Drift proxy. */
export interface ShapDriftResponse {
  ok: boolean;
  version?: string;
  experimental?: boolean;
  scoring_allowed: boolean;
  model_id?: string;
  shap?: {
    method: string;
    values: Record<string, number>;
    baseline: number;
    small_sample: boolean;
    labels?: Record<string, string>;
  };
  drift?: {
    metric: string;
    window: string;
    score: number | null;
    alert: boolean;
  };
  feature_reports_summary?: {
    key?: string;
    adopted?: boolean;
    lift_vs_uniform?: number;
    permutation_p?: number;
    proxy_shap?: number;
  }[];
  explain?: ExplainPayload;
  honesty?: string;
  reason?: string;
  run_at?: string;
}

/** 복기 Pattern Mining 엔진 응답. */
export interface PatternMiningPattern {
  id: string;
  kind: string;
  label: string;
  numbers: number[];
  meta?: Record<string, unknown>;
  appear_rounds: number;
  win_include_rate: number;
  reproduce_rate: number;
  stability: number;
  recent_retention: number;
  continuity: number;
  diversity: number;
  strong_include: number;
  auto_include: number;
  semi_include: number;
  match_retention: number;
  wf_mean_hits: number;
  lift_vs_baseline: number;
  permutation_p: number;
  base_hits?: number;
  /** in-sample(mine 와 같은 회차로 채점) 채택 여부 — 낙관적. */
  in_sample_adopted?: boolean;
  /** 진짜 out-of-sample(확장윈도우 walk-forward) 지표. */
  oos_available?: boolean;
  oos_appear?: number;
  oos_mean_hits?: number;
  oos_lift?: number;
  oos_confirmed?: boolean;
  adopted: boolean;
  use_reasons: string[];
  exclude_reasons: string[];
  per_round?: { round_no: number; fired: boolean; win_overlap: number | null; top_hits: number | null }[];
  last_gate?: GateResult;
}

export interface PatternMiningResponse {
  ok: boolean;
  reason?: string;
  round_count: number;
  current_round_no?: number;
  pattern_count?: number;
  adopted_count?: number;
  rejected_count?: number;
  /** 다중검정 맥락 — N개 패턴을 α로 검정하면 우연으로도 평균 N×α개가 채택돼 보인다. */
  multiple_testing?: {
    n_tested: number;
    alpha: number;
    expected_false_positives: number;
    bonferroni_alpha: number;
    adopted_count: number;
    exceeds_chance: boolean;
  };
  /** in-sample 통과 중 진짜 out-of-sample(확장윈도우 walk-forward)까지 재현한 수. */
  oos_summary?: {
    available: boolean;
    in_sample_adopted: number;
    oos_confirmed: number;
    dropped_by_oos: number;
    test_rounds: number;
    note?: string;
  };
  dataset?: {
    rounds: {
      round_no: number;
      auto_lines: number;
      semi_lines: number;
      strong18: number[];
      match_cards: Record<string, number>;
      winning: number[];
    }[];
    sources: string[];
    note?: string;
  };
  patterns?: PatternMiningPattern[];
  adopted_patterns?: PatternMiningPattern[];
  clusters?: {
    cluster_id: string;
    key: string;
    size: number;
    adopted_count: number;
    mean_lift: number;
    pattern_ids: string[];
    kinds: string[];
  }[];
  feature_selection?: {
    ok: boolean;
    reason?: string;
    kept: string[];
    dropped: string[];
    reports?: { feature: string; kept: boolean; reason?: string; corr?: number }[];
  };
  recommendation?: {
    ok: boolean;
    reason?: string;
    source?: string;
    adopted_pattern_count?: number;
    kept_features?: string[];
    numbers?: {
      number: number;
      score: number;
      features?: Record<string, number>;
      reasons?: {
        pattern_id: string;
        pattern_label: string;
        kind: string;
        stability: number;
        lift: number;
        appear_rounds: number;
        wf_mean_hits: number;
        cluster_id: string | null;
        contribution: number;
      }[];
      in_strong18?: boolean;
      auto_lines?: number;
      semi_lines?: number;
    }[];
    top6?: number[];
    strong18?: number[];
    honesty?: string;
  };
  pipeline?: string[];
  baselines?: { uniform_top6_hits: number };
  honesty?: string;
  explain?: ExplainPayload;
  validation_gates?: ValidationGatesSummary;
  orchestrator?: {
    version?: string;
    candidates?: {
      model_id: string;
      action: string;
      reason: string;
      requires_human?: boolean;
      auto_applied?: boolean;
    }[];
    unchanged?: string[];
    auto_mutate_scoring?: boolean;
    honesty?: string;
  };
  model_registry?: ModelRegistryState;
}

/** 다회차 학습 — 보관 회차 용지 + 실제 당첨 대조 캘리브레이션. */
export interface RoundLearningResponse {
  ok: boolean;
  reason?: string;
  round_count: number;
  rounds?: {
    round_no: number;
    winning_numbers: number[];
    auto_line_count: number;
    semi_line_count: number;
    top6_by_support: number[];
    top6_hits: number;
    frozen_at?: string | null;
  }[];
  calibration?: {
    bucket: string;
    played: number;
    won: number;
    hit_rate: number;
    baseline: number;
    lift: number;
    significance?: BinomialSignificance;
  }[];
  current_round_no?: number;
  apply_intent?: 'review' | 'current_round';
  apply_label?: string;
  apply_source?: string;
  /** 이번회차가 한쪽(자동만/반자동만)만 등록된 상태인지 — 양쪽 지지가 0이 되는 사유. */
  current_one_sided?: boolean;
  current_auto_lines?: number;
  current_semi_lines?: number;
  current_scores?: {
    number: number;
    auto: number;
    semi: number;
    support: number;
    rank?: number;
    bucket: string;
    learned_lift: number;
    score: number;
  }[];
  summary?: {
    total_top6_hits: number;
    expected_top6_hits: number;
    rounds: number;
    calibration_flat: boolean;
    top6_significance?: BinomialSignificance;
  };
  honesty?: string;
  explain?: ExplainPayload;
}

/** 회차별 용지 데이터 분리 — review(복기 저장분) / archived(롤오버 보관분). */
export interface RoundBreakdownItem {
  ticket_round: string;
  review: {
    entry_count: number;
    auto_lines: number;
    semi_lines: number;
    analyzed_at?: string | null;
  } | null;
  archived: {
    entry_count: number;
    auto_lines: number;
    semi_lines: number;
    frozen_at?: string | null;
  } | null;
}

export interface PhotoAnalysisAccumulated {
  total_analyses: number;
  unique_videos?: number;
  unique_photos?: number;
  updated_at?: string;
  historical_dataset?: {
    review_entries: number;
    archived_current_rounds: number;
    latest_archived_round?: number | null;
    latest_archived_current_snapshot?: ArchivedCurrentRoundSnapshot | null;
    /** 회차별 분리 뷰 — 같은 회차에 '복기 저장분'과 '롤오버 보관분'이 공존할 수 있어 구분. */
    rounds_breakdown?: RoundBreakdownItem[];
  };
  current_dataset?: {
    round_no: number;
    status: string;
    entry_count: number;
    derived_datasets: string[];
    rule_snapshots: string[];
    frozen_at?: string | null;
  };
  strong_candidate_votes: VideoVoteItem[];
  excluded_candidate_votes: VideoVoteItem[];
  multiples_votes: VideoVoteItem[];
  identified_multiples: { type: string; numbers: number[] };
  frequency_overlap_patterns: FrequencyOverlapPatterns;
  triple_plus_overlap: {
    pattern_label: string;
    items: FrequencyOverlapItem[];
  };
  line_pattern_votes: { target_number: number; votes: number; pattern_type: string }[];
  final_predictions: {
    strong_candidates: number[];
    excluded_candidates: number[];
  };
  by_ticket_round?: Record<
    string,
    PhotoAnalysisAccumulated & {
      ticket_round: string;
      analysis_count: number;
      dominant_intent?: string;
      dominant_intent_label?: string;
    }
  >;
  by_video_intent?: Record<string, { count: number; ticket_rounds: string[] }>;
  by_intent?: {
    review: PhotoAnalysisIntentSlice;
    current_round: PhotoAnalysisIntentSlice;
  };
  app_ui_message: string;
  legacy_entry_count?: number;
  accumulated_combo_patterns?: ComboDuplicatePatterns;
  saved_review_template?: SavedReviewTemplate | null;
  entries_summary: {
    id: string;
    url: string;
    video_id?: string;
    video_title?: string;
    ticket_round?: string | null;
    ticket_round_confidence?: string;
    video_intent?: string;
    video_intent_label?: string;
    referenced_rounds?: string[];
    detected_round?: string | null;
    analyzed_at: string;
    strong_candidates: number[];
    frequency_overlap_patterns?: FrequencyOverlapPatterns;
    triple_plus_overlap?: FrequencyOverlapItem[];
  }[];
}

export interface PostOccurrenceResponse {
  disclaimer: string;
  warning?: string | null;
  analysis_status?: 'ok' | 'no_eligible_data';
  recommendation_count?: number;
  meta: {
    total_rounds: number;
    latest_round: number;
    trigger_round: number;
    trigger_numbers: number[];
    trigger_bonus: number;
    data_range: string;
  };
  step1_combinations?: {
    total_combo_count: number;
    analysis_combo_count?: number;
    note?: string;
  };
  step2_discovery?: {
    total_discovery_events: number;
    trusted_events: number;
    low_confidence_mode: boolean;
    no_eligible_data?: boolean;
    min_combo_size?: number;
    min_discovery_threshold: number;
    high_confidence_threshold?: number;
    excluded_single_combos?: number;
    excluded_low_discovery_combos?: number;
  };
  step3_next_draw_collection?: { next_events_collected: number };
  duplicate_pattern_analysis?: {
    combo: number[];
    size?: number;
    discovery_count: number;
    next_collection_count: number;
    trusted: boolean;
  }[];
  top20_numbers?: {
    number: number;
    count: number;
    rate: number;
    score: number;
    probability: number;
  }[];
  recency_analysis?: { optimized_lambda: number };
  backtest?: {
    window_rounds: number;
    top6_hit_rate: number;
    top10_hit_rate: number;
    top15_hit_rate: number;
    avg_hit_count: number;
  };
  final_ranking?: {
    rank: number;
    number: number;
    score: number;
    probability: number;
    grade: string;
  }[];
  grades?: { S: number[]; A: number[]; B: number[] };
  recommendations?: Record<
    string,
    { numbers: number[]; expected_score: number; risk: number }[]
  >;
  pattern_analysis?: {
    sample_count?: number;
    frequencies?: {
      simple?: { number: number; count: number }[];
      recent?: { number: number; count: number }[];
    };
    carryover?: { count?: number; rate?: number; pair_rate?: number; triple_rate?: number };
    rates?: Record<string, number>;
    distribution?: Record<string, unknown>;
    number_states?: { long_absent?: number[]; overheated?: number[]; cooled?: number[] };
  };
  bonus_analysis?: {
    sample_count?: number;
    bonus_next_counts?: { number: number; count: number }[];
    bonus_in_main_numbers?: { number: number; count: number }[];
    bonus_repeat_count?: number;
    main_number_top10?: { number: number; count: number; rate: number }[];
  };
  association_rules_top20?: {
    antecedent: number[];
    consequent: number;
    confidence: number;
    lift: number;
  }[];
  similar_rounds_top20?: { round: number; similarity: number; jaccard: number }[];
  evidence?: { match_rounds_used: number; backtest_rounds: number; trusted_only: boolean };
}

export interface PredictionSignalNumber {
  number: number;
  score: number;
  source_count: number;
  signal_count: number;
  sources: string[];
  excluded_by: string[];
  grade: 'S' | 'A' | 'B' | 'C' | 'X';
}

export interface PredictionSignalsResponse {
  rules_version: string;
  target_round: number;
  target_draw_date: string;
  latest_round: number;
  /** 미추첨 다음 회차(참고). 복기 target 와 다를 수 있음. */
  next_round?: number;
  intent: 'review' | 'current_round';
  machine_id: number;
  machine_source?: 'confirmed' | 'estimated' | string;
  auto_machine_id?: number;
  source_weights: Record<string, number>;
  strong_candidates: number[];
  excluded_candidates: number[];
  strong_details: PredictionSignalNumber[];
  excluded_details: PredictionSignalNumber[];
  ranked_numbers: PredictionSignalNumber[];
  by_grade: Record<'S' | 'A' | 'B' | 'C' | 'X', number[]>;
  sources: {
    machine: {
      available: boolean;
      machine_id?: number;
      hot_top5?: { number: number; count: number }[];
      next_round?: number;
    };
    post_occurrence: {
      available: boolean;
      trigger_round?: number;
      grades?: { S?: number[]; A?: number[]; B?: number[] };
    };
    classic: { available: boolean; method?: string; combo_count?: number };
    photo_sheet: {
      available: boolean;
      intent?: string;
      total_analyses?: number;
      ticket_round?: string;
    };
    parallel_round: {
      available: boolean;
      suffix?: number;
      suffix_label?: string;
      parallel_count?: number;
      parallel_strong?: number[];
      semi_auto_fixed_hint?: number[];
      ending_digits?: { digit: number; count: number }[];
      summary?: string;
    };
    decade_gap?: {
      available: boolean;
      include_bonus?: boolean;
      pool?: number[];
      pool_size?: number;
      table?: Record<string, { number: number; gap: number }[]>;
      summary?: string;
    };
  };
  disclaimer: string;
  /** 복기 탭 전용 — 신호원별 과거 적중률 백테스트. */
  signal_accuracy?: PredictionSignalAccuracy;
}

export interface PredictionSignalAccuracySource {
  available: boolean;
  rounds_tested: number;
  avg_hits: number;
  lift_vs_random: number;
  rounds_3plus: number;
  per_round: { round: number; hits: number; predicted: number[] }[];
}

export interface PredictionSignalAccuracy {
  available: boolean;
  rounds: number;
  top_k: number;
  random_baseline: number;
  by_source: Record<string, PredictionSignalAccuracySource>;
  weakest_source: string | null;
  strongest_source: string | null;
  excluded_sources: string[];
  note: string;
}

export interface ParallelRoundDecadeBucket {
  range: [number, number];
  strong: number[];
  expected: number[];
  freq_top: [number, number][];
}

export interface ParallelRoundDrawRow {
  round: number;
  numbers: number[];
  bonus: number;
  draw_date?: string;
}

export interface ParallelRoundAnalysisResponse {
  target_round: number;
  suffix: number;
  suffix_label: string;
  parallel_rounds: number[];
  parallel_count: number;
  draw_table: ParallelRoundDrawRow[];
  by_decade: Record<string, ParallelRoundDecadeBucket>;
  ending_digits: { digit: number; count: number }[];
  parallel_strong: number[];
  parallel_expected: number[];
  semi_auto_fixed_hint: number[];
  travel_highlights: {
    number: number;
    travel_score: number;
    appearances: { round: number; position: number }[];
  }[];
  bonus_freq: { number: number; count: number }[];
  summary: string;
  disclaimer: string;
  error?: string;
}
