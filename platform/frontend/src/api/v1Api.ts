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
  })[];
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
    opts: { sheetIntent?: 'review' | 'current_round'; persist?: boolean } = {}
  ) =>
    fetchJson<PhotoAnalysisJobResult>('/api/v1/photo-analysis/manual', {
      method: 'POST',
      timeoutMs: 120_000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sheet_intent: opts.sheetIntent ?? 'current_round',
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

  getPredictionSignals: (intent: 'review' | 'current_round' = 'current_round', seed?: number) => {
    const q = new URLSearchParams({ intent });
    if (seed != null) q.set('seed', String(seed));
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

  clearPhotoAnalysisStore: (intent?: 'review' | 'current_round') =>
    fetchJson<{ ok: boolean; removed: number }>(
      `/api/v1/photo-analysis/store${intent ? `?intent=${intent}` : ''}`,
      {
      method: 'DELETE',
      }
    ),

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
  intent: 'review' | 'current_round';
  machine_id: number;
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
