/**
 * 반자동 비교 패널
 *
 * 사용 시나리오: 사용자가 실제 구매한 반자동 용지(일부 사용자 픽 + 일부 자동 배정)를
 * 사진/수동으로 입력한 뒤, 본인이 저장한 데이터 + 누적 분석과 비교.
 *
 * 출력:
 *   - 사용자 픽 vs 자동 배정 4축 비교
 *     1. 최근 당첨 번호 (latest draw) 와의 일치
 *     2. 저장된 자동 슬립 (slipQueue, §1 구입번호 직접입력) 와의 라인별 겹침
 *     3. 누적 강한 후보 (accumulated.final_predictions.strong_candidates) 와의 겹침
 *     4. 누적 배제 후보 (excluded_candidates) 와의 겹침 — 경고 지표
 *
 * 정직성: 본 비교는 패턴 관찰 도구. 어떤 일치/불일치도 다음 회차의
 * 1/8,145,060 확률을 변경하지 않는다.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BulkLineInputDialog from './BulkLineInputDialog';
import LottoBall from './LottoBall';
import NumberFrequencyPanel from './NumberFrequencyPanel';
import {
  generateScoredRecommendations,
  type ScoredRecommendation,
} from './reviewRecommendationEngine';
import SavedLinesPanel, {
  GAME_LABELS,
  type GameLabel,
  type SavedLine,
} from './SavedLinesPanel';
import { useConfirm } from './useConfirm';
import {
  v1Api,
  type ComboDuplicateItem,
  type ComboDuplicatePatterns,
  type ManualSlipInput,
  type PhotoAnalysisAccumulated,
  type PredictionSignalNumber,
  type PredictionSignalsResponse,
} from '../api/v1Api';
import { GRADE_COLORS, GRADE_LABELS } from '../utils/compositeAnalysis';

const NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);

// ── 반자동 비교 영속화 (localStorage) ─────────────────────────────
// 탭별 격리: 복기 / 이번회차 각각 별도 저장 (데이터 오염 방지).
const SEMI_AUTO_STORAGE_PREFIX = 'lotto:semiAuto:v1';

function semiAutoStorageKey(intent: SheetIntent): string {
  return `${SEMI_AUTO_STORAGE_PREFIX}:${intent}`;
}

type SheetIntent = 'review' | 'current_round';

const SIGNAL_SOURCE_LABELS: Record<string, string> = {
  'machine-hot': '추첨기 고빈도',
  'machine-synergy': '추첨기 궁합',
  'machine-reversion': '추첨기 회귀',
  'post-S': '후속출현 S',
  'post-A': '후속출현 A',
  'post-top20': '후속출현 Top20',
  'classic-wilson': '클래식 윌슨',
  'classic-huygens': '클래식 호이겐스',
  'classic-fermat': '클래식 페르마',
  'classic-blend': '클래식 혼합',
  'photo-line-overlap': '용지 줄겹침',
  'photo-vote': '용지 누적투표',
  'photo-pair': '용지 페어',
  'photo-triple': '용지 트리플',
  'photo-excluded': '용지 배제',
  'parallel-strong': '평행 강수',
  'parallel-expected': '평행 기대수',
  'parallel-fixed': '평행 고정후보',
  'decade-gap': '구간미출현',
  'local-derived': '로컬 추정',
  'accumulated-fallback': '누적 보조',
};

// 보류(suspend) 임계값. 페어 매칭/요약 비교의 실제 계산 비용은 가벼워서
// (수십만 페어도 수십 ms) 과거 값(180줄/8000페어)은 지나치게 낮아 243×40
// 같은 정상 사용까지 1:1 비교를 0건으로 보류시켰다. 현실적인 상한으로 올리고,
// 그래도 렌더가 폭증하지 않도록 그룹 카드 줄 목록은 별도 캡(아래)으로 제한한다.
const HEAVY_COMPARISON_TICKET_LIMIT = 1_200;
const HEAVY_LINE_PAIR_LIMIT = 200_000;
/** 보류 상태에서 [상세 비교 보기] 강제 시 경량 비교에 사용할 상위 줄 수 캡. */
const FORCE_DETAILED_TICKET_CAP = 200;
/** 1:1 매칭 그룹 카드에서 한쪽(자동/반자동) 일치 줄을 최대 몇 개까지 렌더할지. */
const GROUP_LINE_RENDER_CAP = 40;

function signalSourceLabel(source: string): string {
  return SIGNAL_SOURCE_LABELS[source] ?? source;
}

function summarizeSignalReason(item: PredictionSignalNumber): string {
  if (item.excluded_by.length > 0) {
    return `배제 근거 ${item.excluded_by.length}개 · ${item.excluded_by.map(signalSourceLabel).join(', ')}`;
  }
  return `${item.signal_count}개 신호 · ${item.source_count}개 계열 합의`;
}

type PersistedSemiAutoState = {
  picked: number[];
  pickFlags: Record<number, 'user' | 'auto'>;
  bulkTickets: number[][];
  /** 자동 패턴: 현재 입력 중 용지의 A~E 줄 (각 6개). */
  semiCurrentLines: SavedLine[];
  /** 자동 패턴: 5줄 완성된 용지들의 누적. */
  semiSlipQueue: ManualSlipInput[];
  /** 사용자가 [누적·저장] 으로 명시적으로 확정한 마지막 시각 (ISO). */
  lastSavedAt: string | null;
};

function defaultPersistedState(): PersistedSemiAutoState {
  return {
    picked: [],
    pickFlags: {},
    bulkTickets: [],
    semiCurrentLines: [],
    semiSlipQueue: [],
    lastSavedAt: null,
  };
}

const isGameLabel = (v: unknown): v is GameLabel =>
  typeof v === 'string' && (GAME_LABELS as readonly string[]).includes(v);

function sanitizeSavedLine(raw: unknown): SavedLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<SavedLine>;
  if (!isGameLabel(obj.label)) return null;
  if (!Array.isArray(obj.numbers)) return null;
  const numbers = obj.numbers.filter(
    (n): n is number => Number.isInteger(n) && n >= 1 && n <= 45
  );
  if (numbers.length !== 6) return null;
  return { label: obj.label, numbers };
}

function sanitizeSlipInput(raw: unknown): ManualSlipInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<ManualSlipInput>;
  if (!Array.isArray(obj.lines)) return null;
  const lines = obj.lines
    .map((line) => sanitizeSavedLine(line))
    .filter((line): line is SavedLine => line !== null);
  if (lines.length === 0) return null;
  return { lines };
}

function loadSemiAutoState(intent: SheetIntent): PersistedSemiAutoState {
  if (typeof window === 'undefined') return defaultPersistedState();
  try {
    const raw =
      window.localStorage.getItem(semiAutoStorageKey(intent)) ??
      // 레거시 단일 키 → 복기 탭으로 1회 이관
      (intent === 'review' ? window.localStorage.getItem('lotto:semiAuto:v1') : null);
    if (!raw) return defaultPersistedState();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return defaultPersistedState();
    const obj = parsed as Partial<PersistedSemiAutoState> & { savedLines?: unknown };
    const picked = Array.isArray(obj.picked)
      ? obj.picked.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 45)
      : [];
    const pickFlags: Record<number, 'user' | 'auto'> = {};
    if (obj.pickFlags && typeof obj.pickFlags === 'object') {
      for (const [k, v] of Object.entries(obj.pickFlags as Record<string, unknown>)) {
        const n = Number(k);
        if (Number.isInteger(n) && n >= 1 && n <= 45 && (v === 'user' || v === 'auto')) {
          pickFlags[n] = v;
        }
      }
    }
    const bulkTickets: number[][] = Array.isArray(obj.bulkTickets)
      ? obj.bulkTickets
          .filter((t): t is number[] => Array.isArray(t))
          .map((t) => t.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 45))
          .filter((t) => t.length === 6)
      : [];

    let semiCurrentLines: SavedLine[] = Array.isArray(obj.semiCurrentLines)
      ? obj.semiCurrentLines
          .map((l) => sanitizeSavedLine(l))
          .filter((l): l is SavedLine => l !== null)
          .slice(0, GAME_LABELS.length)
      : [];
    let semiSlipQueue: ManualSlipInput[] = Array.isArray(obj.semiSlipQueue)
      ? obj.semiSlipQueue
          .map((s) => sanitizeSlipInput(s))
          .filter((s): s is ManualSlipInput => s !== null)
      : [];

    // ── 마이그레이션: 직전 v1 의 평탄한 savedLines (number[][]) →
    //    5줄씩 묶어 semiSlipQueue + 잔여 → semiCurrentLines.
    if (
      semiCurrentLines.length === 0 &&
      semiSlipQueue.length === 0 &&
      Array.isArray(obj.savedLines)
    ) {
      const flat = (obj.savedLines as unknown[])
        .filter((t): t is number[] => Array.isArray(t))
        .map((t) => t.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 45))
        .filter((t) => t.length === 6);
      const migratedSlips: ManualSlipInput[] = [];
      for (let i = 0; i + GAME_LABELS.length <= flat.length; i += GAME_LABELS.length) {
        migratedSlips.push({
          lines: flat
            .slice(i, i + GAME_LABELS.length)
            .map((numbers, idx) => ({ label: GAME_LABELS[idx], numbers })),
        });
      }
      const remainder = flat.slice(migratedSlips.length * GAME_LABELS.length);
      semiSlipQueue = migratedSlips;
      semiCurrentLines = remainder.map((numbers, idx) => ({
        label: GAME_LABELS[idx],
        numbers,
      }));
    }

    // 라벨 재할당 — 인덱스 기준으로 강제 정렬 (저장 시 라벨 누락 가드)
    semiCurrentLines = semiCurrentLines.map((line, idx) => ({
      ...line,
      label: GAME_LABELS[idx] ?? line.label,
    }));

    const lastSavedAt: string | null =
      typeof obj.lastSavedAt === 'string' && obj.lastSavedAt.length > 0
        ? obj.lastSavedAt
        : null;

    return {
      picked,
      pickFlags,
      bulkTickets,
      semiCurrentLines,
      semiSlipQueue,
      lastSavedAt,
    };
  } catch {
    return defaultPersistedState();
  }
}

function saveSemiAutoState(intent: SheetIntent, state: PersistedSemiAutoState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(semiAutoStorageKey(intent), JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
}

function getIntentComboPatterns(
  accumulated: PhotoAnalysisAccumulated | null,
  intent: SheetIntent
): ComboDuplicatePatterns | null {
  if (!accumulated) return null;
  return accumulated.by_intent?.[intent]?.accumulated_combo_patterns ?? null;
}

function collectAutoOnlyLines(
  currentSlipLines: SavedLine[],
  slipQueue: ManualSlipInput[],
  bulkAutoTickets: number[][]
): number[][] {
  const out: number[][] = [];
  for (const line of currentSlipLines) out.push(line.numbers);
  for (const slip of slipQueue) {
    for (const line of slip.lines) out.push(line.numbers);
  }
  for (const ticket of bulkAutoTickets) out.push(ticket);
  return out;
}

/** 서버 누적 없을 때 자동 줄 빈도·줄간 겹침으로 강한 후보 추정 (백엔드 line_overlap 근사). */
function deriveLocalStrongCandidates(
  autoLines: number[][],
  winningNumbers: number[],
  intent: SheetIntent,
  limit = 18
): number[] {
  if (autoLines.length === 0) return [];

  const scores: Record<number, number> = {};
  const bump = (n: number, w: number) => {
    if (Number.isInteger(n) && n >= 1 && n <= 45) {
      scores[n] = (scores[n] ?? 0) + w;
    }
  };

  const normalized = autoLines.map((line) =>
    Array.from(new Set(line.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45))).sort(
      (a, b) => a - b
    )
  );

  const pairLineHits: Record<string, number> = {};
  const tripleLineHits: Record<string, number> = {};
  for (const nums of normalized) {
    for (let i = 0; i < nums.length; i += 1) {
      for (let j = i + 1; j < nums.length; j += 1) {
        const key = `${nums[i]}-${nums[j]}`;
        pairLineHits[key] = (pairLineHits[key] ?? 0) + 1;
      }
    }
    for (let i = 0; i < nums.length; i += 1) {
      for (let j = i + 1; j < nums.length; j += 1) {
        for (let k = j + 1; k < nums.length; k += 1) {
          const key = `${nums[i]}-${nums[j]}-${nums[k]}`;
          tripleLineHits[key] = (tripleLineHits[key] ?? 0) + 1;
        }
      }
    }
  }

  for (const [key, lineCount] of Object.entries(pairLineHits)) {
    if (lineCount >= 2) {
      for (const n of key.split('-').map(Number)) bump(n, 2 * lineCount);
    }
  }
  for (const [key, lineCount] of Object.entries(tripleLineHits)) {
    if (lineCount >= 2) {
      for (const n of key.split('-').map(Number)) bump(n, 3 * lineCount);
    }
  }

  if (intent === 'review' && winningNumbers.length > 0) {
    const winSet = new Set(winningNumbers);
    for (const nums of normalized) {
      const overlap = nums.filter((n) => winSet.has(n));
      const weight = overlap.length ** 2;
      for (const n of overlap) bump(n, weight);
    }
  }

  for (const nums of normalized) {
    for (const n of nums) bump(n, 1);
  }

  return Object.entries(scores)
    .sort(([, a], [, b]) => b - a || Number(a) - Number(b))
    .slice(0, limit)
    .map(([n]) => Number(n));
}

function getIntentStrongCandidates(
  accumulated: PhotoAnalysisAccumulated | null,
  intent: SheetIntent
): number[] {
  const combo = getIntentComboPatterns(accumulated, intent);
  if (combo?.strong_candidates?.length) return combo.strong_candidates;

  const sliceStrong = accumulated?.by_intent?.[intent]?.final_predictions?.strong_candidates;
  if (sliceStrong?.length) return sliceStrong;

  if (intent === 'review') {
    const votes: Record<number, number> = {};
    for (const entry of accumulated?.entries_summary ?? []) {
      if (entry.video_intent !== 'review') continue;
      for (const n of entry.strong_candidates ?? []) {
        if (Number.isInteger(n) && n >= 1 && n <= 45) {
          votes[n] = (votes[n] ?? 0) + 1;
        }
      }
    }
    const ranked = Object.entries(votes)
      .sort(([, a], [, b]) => b - a || Number(a) - Number(b))
      .map(([n]) => Number(n));
    if (ranked.length) return ranked.slice(0, 18);
  }
  return [];
}

function resolveStrongCandidates(
  accumulated: PhotoAnalysisAccumulated | null,
  intent: SheetIntent,
  autoLines: number[][],
  winningNumbers: number[]
): { candidates: number[]; source: 'backend' | 'local' | 'none' } {
  const backend = getIntentStrongCandidates(accumulated, intent);
  if (backend.length > 0) return { candidates: backend, source: 'backend' };
  const local = deriveLocalStrongCandidates(autoLines, winningNumbers, intent);
  if (local.length > 0) return { candidates: local, source: 'local' };
  return { candidates: [], source: 'none' };
}

function getIntentExcludedCandidates(
  accumulated: PhotoAnalysisAccumulated | null,
  intent: SheetIntent
): number[] {
  const sliceExcluded = accumulated?.by_intent?.[intent]?.final_predictions?.excluded_candidates;
  if (sliceExcluded?.length) return sliceExcluded;
  if (intent === 'review') {
    return accumulated?.final_predictions?.excluded_candidates ?? [];
  }
  return [];
}

function getCurrentRoundStrongCandidates(
  accumulated: PhotoAnalysisAccumulated | null
): number[] {
  return getIntentStrongCandidates(accumulated, 'current_round');
}

function getCurrentRoundComboPatterns(
  accumulated: PhotoAnalysisAccumulated | null
): ComboDuplicatePatterns | null {
  return getIntentComboPatterns(accumulated, 'current_round');
}

function getCurrentRoundExcludedCandidates(
  accumulated: PhotoAnalysisAccumulated | null
): number[] {
  return getIntentExcludedCandidates(accumulated, 'current_round');
}

/**
 * 반자동 티켓의 6개 번호 안에 누적 자동의 자주-페어/자주-트리플이
 * 통째로 포함되어 있는지 측정 — 콤보 교집합.
 *
 * 예: 반자동 티켓 [3, 12, 15, 23, 28, 45]
 *     누적 자주-페어 [12, 23] (5장에서 함께 등장)
 *     → 매치 (티켓이 12, 23 모두 포함)
 */
function findComboMatches(
  ticket: number[],
  combos: ComboDuplicatePatterns | null
): {
  matchedPairs: ComboDuplicateItem[];
  matchedTriples: ComboDuplicateItem[];
  matchedQuads: ComboDuplicateItem[];
} {
  const ticketSet = new Set(ticket);
  const matchedPairs: ComboDuplicateItem[] = [];
  const matchedTriples: ComboDuplicateItem[] = [];
  const matchedQuads: ComboDuplicateItem[] = [];
  if (!combos) return { matchedPairs, matchedTriples, matchedQuads };

  for (const p of combos.pair_duplicates ?? []) {
    if (p.numbers.every((n) => ticketSet.has(n))) matchedPairs.push(p);
  }
  for (const t of combos.triple_duplicates ?? []) {
    if (t.numbers.every((n) => ticketSet.has(n))) matchedTriples.push(t);
  }
  for (const q of combos.quad_duplicates ?? []) {
    if (q.numbers.every((n) => ticketSet.has(n))) matchedQuads.push(q);
  }
  return { matchedPairs, matchedTriples, matchedQuads };
}

interface SemiAutoComparePanelProps {
  slipQueue: ManualSlipInput[];
  accumulated: PhotoAnalysisAccumulated | null;
  onAccumulatedChange?: (next: PhotoAnalysisAccumulated) => void;
  /** 복기 / 이번회차 — 당첨번호 비교는 복기 탭에서만 */
  sheetIntent: SheetIntent;
  currentRound?: number | null;
  latestRound?: number | null;
  roundDrawn?: boolean;
  /** 사용자 정정: '구입번호 직접입력' (slipQueue) = 자동. 그 줄 단위 삭제 콜백. */
  onRemoveSlipLine?: (slipIdx: number, lineIdx: number) => void;
  /** 자동 누적의 '입력 중' 줄 (currentSlipLines). 전체 티켓 목록 카운트·표시에 합산. */
  currentSlipLines?: SavedLine[];
  /** 자동 대량 입력 (bulkAutoTickets). 전체 티켓 목록 카운트·표시에 합산. */
  bulkAutoTickets?: number[][];
  /** 자동 '입력 중' 줄 단건 삭제 콜백. */
  onRemoveCurrentLine?: (idx: number) => void;
  /** 자동 대량 1장 단건 삭제 콜백. */
  onRemoveBulkAutoTicket?: (idx: number) => void;
  /** 서버 누적·당첨번호 재조회 (재분석 버튼). */
  onRefreshAccumulated?: () => Promise<void>;
}

type PickType = 'user' | 'auto';

interface SlipOverlap {
  slipIdx: number;
  lineLabel: string;
  userOverlap: number[];
  autoOverlap: number[];
}

interface MatchedLineEntry {
  idx: number;
  label: string;
  numbers: number[];
}

interface LineMatchGroup {
  key: string;
  matchCount: number;
  matchedNumbers: number[];
  autoList: MatchedLineEntry[];
  semiList: MatchedLineEntry[];
}

interface ComparisonResult {
  userPicks: number[];
  autoPicks: number[];
  vsLatest: {
    available: boolean;
    winningNumbers: number[];
    bonus: number | null;
    userMatch: number[];
    autoMatch: number[];
    bonusMatch: { user: boolean; auto: boolean };
  };
  vsSavedSlips: {
    slipCount: number;
    overlaps: SlipOverlap[];
    bestOverlap: SlipOverlap | null;
  };
  vsStrong: {
    available: boolean;
    strongCandidates: number[];
    userMatch: number[];
    autoMatch: number[];
  };
  vsExcluded: {
    available: boolean;
    excludedCandidates: number[];
    userMatch: number[];
    autoMatch: number[];
    warning: boolean;
  };
}

// ── 대량 비교 결과 ───────────────────────────────────────────────
interface BulkTicketResult {
  index: number;
  ticket: number[];
  vsLatestMatch: number[];
  vsStrongMatch: number[];
  vsExcludedMatch: number[];
  bonusMatch: boolean;
  savedSlipOverlapMax: number;
  // 콤보 교집합 — 누적 자동의 자주-페어/트리플 매치
  matchedPairCount: number;
  matchedTripleCount: number;
  matchedQuadCount: number;
  // 종합 콤보 점수 (가중: 페어 1, 트리플 3, 쿼드 6)
  comboScore: number;
}

/**
 * 교집합 세트 그룹 — 정확히 N개 번호가 강한 후보와 겹친 케이스를
 * 같은 번호 세트별로 묶은 결과.
 *
 * 예: 2개 겹친 티켓이 50장인데, 그 중 [3, 15] 가 8장, [12, 23] 가 5장 등...
 *     이걸 빈도순으로 정렬해 노출.
 */
interface IntersectionGroup {
  numbers: number[]; // 정렬된 교집합 세트
  size: number;
  ticketCount: number;
  ticketIndices: number[]; // 어느 티켓들이 이 세트를 가졌는지 (디버깅/드릴다운용)
}

interface BulkComparisonResult {
  ticketCount: number;
  uniqueNumberCount: number;
  perTicket: BulkTicketResult[];
  hitDistribution: Record<number, number>;
  avgHits: number;
  hitRates: {
    threePlus: number;
    fourPlus: number;
    fivePlus: number;
    six: number;
  };
  bestTickets: BulkTicketResult[];
  excludedWarningCount: number;
  strongIntersectionDistribution: Record<number, number>;
  twoPlusStrongCount: number;
  threePlusStrongCount: number;
  // 교집합 세트 그룹 — 정확히 그 크기로 겹친 케이스
  twoIntersectionGroups: IntersectionGroup[];   // size=2 빈도 TOP 10
  threeIntersectionGroups: IntersectionGroup[]; // size=3 빈도 TOP 10
  fourPlusIntersectionGroups: IntersectionGroup[]; // size>=4 빈도 TOP 5
  pairMatchDistribution: Record<number, number>;
  tripleMatchDistribution: Record<number, number>;
  avgPairMatches: number;
  avgTripleMatches: number;
  bestComboTickets: BulkTicketResult[];
  /** 강한후보·콤보 패턴 종합 — 당첨번호 미사용 (예측 신호용). */
  bestSignalTickets: BulkTicketResult[];
  comboDataAvailable: boolean;
}

function ticketSignalScore(t: BulkTicketResult): number {
  return (
    t.comboScore +
    t.vsStrongMatch.length * 4 +
    t.matchedPairCount * 2 +
    t.matchedTripleCount * 5 +
    t.matchedQuadCount * 8
  );
}

function buildBulkComparison(
  tickets: number[][],
  slipQueue: ManualSlipInput[],
  accumulated: PhotoAnalysisAccumulated | null,
  latestNumbers: number[],
  latestBonus: number | null,
  intent: SheetIntent,
  strongCandidates: number[]
): BulkComparisonResult {
  const latestSet = new Set(latestNumbers);

  const excludedCandidates = getIntentExcludedCandidates(accumulated, intent);
  const comboPatterns = getIntentComboPatterns(accumulated, intent);
  const strongSet = new Set(strongCandidates);
  const excludedSet = new Set(excludedCandidates);
  const comboDataAvailable = !!comboPatterns &&
    ((comboPatterns.pair_duplicates?.length ?? 0) > 0 ||
      (comboPatterns.triple_duplicates?.length ?? 0) > 0);

  const uniqueNumbers = new Set<number>();
  const perTicket: BulkTicketResult[] = [];
  const hitDistribution: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const strongIntersectionDistribution: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const pairMatchDistribution: Record<number, number> = {};
  const tripleMatchDistribution: Record<number, number> = {};
  // 교집합 세트 그룹화 — 정규형 키 → 그룹
  const intersectionGroupsByKey: Record<string, IntersectionGroup> = {};
  let totalHits = 0;
  let totalPairMatches = 0;
  let totalTripleMatches = 0;
  let twoPlusStrongCount = 0;
  let threePlusStrongCount = 0;
  let excludedWarningCount = 0;

  tickets.forEach((ticket, index) => {
    ticket.forEach((n) => uniqueNumbers.add(n));

    const vsLatestMatch = ticket.filter((n) => latestSet.has(n));
    const vsStrongMatch = ticket.filter((n) => strongSet.has(n));
    const vsExcludedMatch = ticket.filter((n) => excludedSet.has(n));
    const bonusMatch = latestBonus != null && ticket.includes(latestBonus);

    // 가장 큰 슬립 라인 겹침
    let maxSlipOverlap = 0;
    for (const slip of slipQueue) {
      for (const line of slip.lines) {
        const overlap = ticket.filter((n) => line.numbers.includes(n)).length;
        if (overlap > maxSlipOverlap) maxSlipOverlap = overlap;
      }
    }

    // 콤보 교집합 — 누적 자동의 자주-페어/트리플 매치
    const { matchedPairs, matchedTriples, matchedQuads } = findComboMatches(ticket, comboPatterns);
    const pairCount = matchedPairs.length;
    const tripleCount = matchedTriples.length;
    const quadCount = matchedQuads.length;
    const comboScore = pairCount + tripleCount * 3 + quadCount * 6;

    perTicket.push({
      index,
      ticket,
      vsLatestMatch,
      vsStrongMatch,
      vsExcludedMatch,
      bonusMatch,
      savedSlipOverlapMax: maxSlipOverlap,
      matchedPairCount: pairCount,
      matchedTripleCount: tripleCount,
      matchedQuadCount: quadCount,
      comboScore,
    });

    const hits = vsLatestMatch.length;
    hitDistribution[hits] = (hitDistribution[hits] ?? 0) + 1;
    totalHits += hits;
    if (vsExcludedMatch.length >= 2) excludedWarningCount += 1;

    const strongInt = vsStrongMatch.length;
    strongIntersectionDistribution[strongInt] = (strongIntersectionDistribution[strongInt] ?? 0) + 1;
    if (strongInt >= 2) twoPlusStrongCount += 1;
    if (strongInt >= 3) threePlusStrongCount += 1;

    // 교집합 세트 그룹화 — 정확히 어느 번호가 겹쳤는지 추적
    if (vsStrongMatch.length >= 2) {
      const sortedIntersection = [...vsStrongMatch].sort((a, b) => a - b);
      const key = sortedIntersection.join('-');
      if (!intersectionGroupsByKey[key]) {
        intersectionGroupsByKey[key] = {
          numbers: sortedIntersection,
          size: sortedIntersection.length,
          ticketCount: 0,
          ticketIndices: [],
        };
      }
      intersectionGroupsByKey[key].ticketCount += 1;
      intersectionGroupsByKey[key].ticketIndices.push(index);
    }

    pairMatchDistribution[pairCount] = (pairMatchDistribution[pairCount] ?? 0) + 1;
    tripleMatchDistribution[tripleCount] = (tripleMatchDistribution[tripleCount] ?? 0) + 1;
    totalPairMatches += pairCount;
    totalTripleMatches += tripleCount;
  });

  const ticketCount = tickets.length;
  const avgHits = ticketCount > 0 ? totalHits / ticketCount : 0;
  const avgPairMatches = ticketCount > 0 ? totalPairMatches / ticketCount : 0;
  const avgTripleMatches = ticketCount > 0 ? totalTripleMatches / ticketCount : 0;

  const threePlus = (hitDistribution[3] + hitDistribution[4] + hitDistribution[5] + hitDistribution[6]) / ticketCount;
  const fourPlus = (hitDistribution[4] + hitDistribution[5] + hitDistribution[6]) / ticketCount;
  const fivePlus = (hitDistribution[5] + hitDistribution[6]) / ticketCount;
  const six = hitDistribution[6] / ticketCount;

  const bestTickets = [...perTicket]
    .sort((a, b) => {
      const aScore = a.vsLatestMatch.length + (a.bonusMatch ? 0.5 : 0);
      const bScore = b.vsLatestMatch.length + (b.bonusMatch ? 0.5 : 0);
      return bScore - aScore;
    })
    .slice(0, 5);

  // 콤보 점수 상위 5개 — 누적 자동과 가장 잘 맞은 티켓
  const bestComboTickets = [...perTicket]
    .filter((t) => t.comboScore > 0)
    .sort((a, b) => b.comboScore - a.comboScore || b.vsStrongMatch.length - a.vsStrongMatch.length)
    .slice(0, 5);

  const bestSignalTickets = [...perTicket]
    .filter((t) => ticketSignalScore(t) > 0)
    .sort((a, b) => ticketSignalScore(b) - ticketSignalScore(a))
    .slice(0, 5);

  // 교집합 세트 그룹을 크기별로 분류 + 빈도순 정렬 (상한 없음 — 모든 세트 노출)
  const allGroups = Object.values(intersectionGroupsByKey);
  const twoIntersectionGroups = allGroups
    .filter((g) => g.size === 2)
    .sort((a, b) => b.ticketCount - a.ticketCount || a.numbers[0] - b.numbers[0]);
  const threeIntersectionGroups = allGroups
    .filter((g) => g.size === 3)
    .sort((a, b) => b.ticketCount - a.ticketCount || a.numbers[0] - b.numbers[0]);
  const fourPlusIntersectionGroups = allGroups
    .filter((g) => g.size >= 4)
    .sort((a, b) => b.size - a.size || b.ticketCount - a.ticketCount);

  return {
    ticketCount,
    uniqueNumberCount: uniqueNumbers.size,
    perTicket,
    hitDistribution,
    avgHits,
    hitRates: { threePlus, fourPlus, fivePlus, six },
    bestTickets,
    excludedWarningCount,
    strongIntersectionDistribution,
    twoPlusStrongCount,
    threePlusStrongCount,
    twoIntersectionGroups,
    threeIntersectionGroups,
    fourPlusIntersectionGroups,
    pairMatchDistribution,
    tripleMatchDistribution,
    avgPairMatches,
    avgTripleMatches,
    bestComboTickets,
    bestSignalTickets,
    comboDataAvailable,
  };
}

function buildComparison(
  picked: number[],
  pickFlags: Record<number, PickType>,
  slipQueue: ManualSlipInput[],
  accumulated: PhotoAnalysisAccumulated | null,
  sheetIntent: SheetIntent,
  latestNumbers: number[],
  latestBonus: number | null,
  strongCandidates: number[]
): ComparisonResult {
  // 'auto' 분류는 사진 (단건) 제거 후 더 이상 발생하지 않음.
  // 분류 미지정 (legacy 로딩 / 신규 입력) = user 로 간주 → 비교 결과가 정상 동작.
  const userPicks = picked.filter((n) => pickFlags[n] !== 'auto').sort((a, b) => a - b);
  const autoPicks = picked.filter((n) => pickFlags[n] === 'auto').sort((a, b) => a - b);

  const latestSet = new Set(latestNumbers);
  const vsLatest = {
    available: latestNumbers.length > 0,
    winningNumbers: latestNumbers,
    bonus: latestBonus,
    userMatch: userPicks.filter((n) => latestSet.has(n)),
    autoMatch: autoPicks.filter((n) => latestSet.has(n)),
    bonusMatch: {
      user: latestBonus != null && userPicks.includes(latestBonus),
      auto: latestBonus != null && autoPicks.includes(latestBonus),
    },
  };

  const overlaps: SlipOverlap[] = [];
  slipQueue.forEach((slip, sIdx) => {
    slip.lines.forEach((line) => {
      const lineSet = new Set(line.numbers);
      const userOverlap = userPicks.filter((n) => lineSet.has(n));
      const autoOverlap = autoPicks.filter((n) => lineSet.has(n));
      if (userOverlap.length + autoOverlap.length > 0) {
        overlaps.push({
          slipIdx: sIdx,
          lineLabel: line.label,
          userOverlap,
          autoOverlap,
        });
      }
    });
  });
  overlaps.sort(
    (a, b) =>
      b.userOverlap.length + b.autoOverlap.length - (a.userOverlap.length + a.autoOverlap.length)
  );

  const strongSet = new Set(strongCandidates);
  const vsStrong = {
    available: strongCandidates.length > 0,
    strongCandidates,
    userMatch: userPicks.filter((n) => strongSet.has(n)),
    autoMatch: autoPicks.filter((n) => strongSet.has(n)),
  };

  const excludedCandidates = getIntentExcludedCandidates(accumulated, sheetIntent);
  const excludedSet = new Set(excludedCandidates);
  const userExcluded = userPicks.filter((n) => excludedSet.has(n));
  const autoExcluded = autoPicks.filter((n) => excludedSet.has(n));
  const vsExcluded = {
    available: excludedCandidates.length > 0,
    excludedCandidates,
    userMatch: userExcluded,
    autoMatch: autoExcluded,
    warning: userExcluded.length + autoExcluded.length >= 2,
  };

  return {
    userPicks,
    autoPicks,
    vsLatest,
    vsSavedSlips: {
      slipCount: slipQueue.length,
      overlaps: overlaps.slice(0, 5),
      bestOverlap: overlaps[0] ?? null,
    },
    vsStrong,
    vsExcluded,
  };
}

function MatchBadge({ label, count, of, color = 'default' }: { label: string; count: number; of: number; color?: 'success' | 'warning' | 'error' | 'default' }) {
  const colorMap = {
    success: '#69C8F2',
    warning: '#FFA94D',
    error: '#FF4D4D',
    default: '#9CA3AF',
  };
  return (
    <Chip
      size="small"
      label={`${label} ${count}/${of}`}
      sx={{
        bgcolor: count > 0 ? colorMap[color] : 'transparent',
        color: count > 0 ? '#fff' : 'text.secondary',
        border: count > 0 ? 'none' : '1px solid',
        borderColor: 'divider',
        fontWeight: 700,
      }}
    />
  );
}

function SignalExplanationPanel({
  predictionSignals,
  resolvedStrongCandidates,
  resolvedExcludedCandidates,
  strongCandidateSource,
}: {
  predictionSignals: PredictionSignalsResponse | null;
  resolvedStrongCandidates: number[];
  resolvedExcludedCandidates: number[];
  strongCandidateSource: 'unified-rules' | 'backend' | 'local' | 'none';
}) {
  const buildFallbackStrongItems = (): PredictionSignalNumber[] => {
    const source =
      strongCandidateSource === 'local'
        ? 'local-derived'
        : strongCandidateSource === 'backend'
          ? 'accumulated-fallback'
          : 'local-derived';
    return resolvedStrongCandidates.slice(0, 8).map((number, idx) => ({
      number,
      score: Math.max(0, resolvedStrongCandidates.length - idx),
      source_count: 1,
      signal_count: 1,
      sources: [source],
      excluded_by: [],
      grade: 'C' as const,
    }));
  };

  const buildFallbackExcludedItems = (): PredictionSignalNumber[] =>
    resolvedExcludedCandidates.slice(0, 6).map((number, idx) => ({
      number,
      score: idx,
      source_count: 1,
      signal_count: 1,
      sources: [],
      excluded_by: ['photo-excluded'],
      grade: 'X' as const,
    }));

  const strongItems =
    predictionSignals?.strong_details?.length
      ? predictionSignals.strong_details.slice(0, 8)
      : buildFallbackStrongItems();
  const excludedItems =
    predictionSignals?.excluded_details?.length
      ? predictionSignals.excluded_details.slice(0, 6)
      : buildFallbackExcludedItems();
  const usingFallback = !predictionSignals?.strong_details?.length && strongItems.length > 0;

  const renderItems = (
    title: string,
    items: PredictionSignalNumber[],
    emptyHint: string,
  ) => (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.75 }}>
        {title}
      </Typography>
      {items.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {emptyHint}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {items.map((item) => (
            <Box
              key={`explain-${title}-${item.number}`}
              sx={{
                p: 1,
                borderRadius: 1,
                bgcolor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                <LottoBall number={item.number} size={28} />
                <Chip
                  size="small"
                  label={`${item.grade} · 점수 ${item.score.toFixed(1)}`}
                  sx={{
                    bgcolor: GRADE_COLORS[item.grade],
                    color: item.grade === 'C' ? 'text.primary' : '#fff',
                    fontWeight: 700,
                  }}
                />
                <Typography variant="caption" color="text.secondary">
                  {summarizeSignalReason(item)}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {item.sources.map((src) => (
                  <Chip
                    key={`src-${item.number}-${src}`}
                    size="small"
                    variant="outlined"
                    label={
                      predictionSignals?.source_weights?.[src] != null
                        ? `${signalSourceLabel(src)} (+${predictionSignals.source_weights[src].toFixed(1)})`
                        : signalSourceLabel(src)
                    }
                  />
                ))}
                {item.excluded_by.map((src) => (
                  <Chip
                    key={`exc-${item.number}-${src}`}
                    size="small"
                    color="error"
                    variant="outlined"
                    label={`${signalSourceLabel(src)} (배제)`}
                  />
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.75 }}>
        왜 이 번호가 나왔나요?
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        강한 후보는 점수·계열 합의로, 배제 후보는 exclusion 신호가 붙은 번호로 설명합니다.
      </Typography>
      {usingFallback && (
        <Alert severity="info" sx={{ mb: 1 }}>
          통합 신호 상세가 비어 있어 현재 화면에서 사용 중인 강한 후보를 로컬/누적 기준으로 설명합니다.
        </Alert>
      )}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
        {renderItems('강한 후보 근거', strongItems, '표시할 강한 후보 근거가 없습니다.')}
        {renderItems('배제 후보 근거', excludedItems, '표시할 배제 후보 근거가 없습니다.')}
      </Stack>
    </Box>
  );
}

export default function SemiAutoComparePanel({
  slipQueue,
  accumulated,
  onAccumulatedChange,
  sheetIntent,
  currentRound = null,
  latestRound: latestRoundProp = null,
  roundDrawn = false,
  onRemoveSlipLine,
  currentSlipLines = [],
  bulkAutoTickets = [],
  onRemoveCurrentLine,
  onRemoveBulkAutoTicket,
  onRefreshAccumulated,
}: SemiAutoComparePanelProps) {
  const { confirm, ConfirmDialog } = useConfirm();
  const lineMatchingRef = useRef<HTMLDivElement | null>(null);
  const [lineMatchFilter, setLineMatchFilter] = useState<'all' | 2 | 3 | 4 | 5 | 6>('all');
  const [lineMatchNumberFilter, setLineMatchNumberFilter] = useState('');
  const compareWinning = sheetIntent === 'review';

  // localStorage — 탭별 격리
  const initial = useMemo(() => loadSemiAutoState(sheetIntent), [sheetIntent]);
  const [picked, setPicked] = useState<number[]>(initial.picked);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTickets, setBulkTickets] = useState<number[][]>(initial.bulkTickets);
  /** 현재 입력 중 용지의 A~E 줄 (자동 패턴과 동일). */
  const [semiCurrentLines, setSemiCurrentLines] = useState<SavedLine[]>(
    initial.semiCurrentLines
  );
  /** 5줄 완성된 용지 누적. */
  const [semiSlipQueue, setSemiSlipQueue] = useState<ManualSlipInput[]>(
    initial.semiSlipQueue
  );
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  /** 사용자가 명시적으로 [누적·저장] 누른 마지막 시각 (ISO). */
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(initial.lastSavedAt);
  const [compareRound, setCompareRound] = useState<number | null>(null);
  /**
   * 대량 입력이 많아 자동 보류된 상태에서 사용자가 [상세 비교 보기] 를 누르면
   * 상위 일부(캡)만으로 경량 비교(상세 교집합/요약)를 강제 표시한다.
   * 무거운 1:1 전수비교는 브라우저 보호를 위해 보류 유지.
   */
  const [forceDetailedComparison, setForceDetailedComparison] = useState(false);

  // 탭 전환 시 해당 탭 전용 localStorage 로드
  useEffect(() => {
    const st = loadSemiAutoState(sheetIntent);
    setPicked(st.picked);
    setBulkTickets(st.bulkTickets);
    setSemiCurrentLines(st.semiCurrentLines);
    setSemiSlipQueue(st.semiSlipQueue);
    setLastSavedAt(st.lastSavedAt);
    setCompareRound(null);
    setForceDetailedComparison(false);
  }, [sheetIntent]);

  // 영속 — picked / bulkTickets / semiCurrentLines / semiSlipQueue / lastSavedAt
  useEffect(() => {
    saveSemiAutoState(sheetIntent, {
      picked,
      pickFlags: {},
      bulkTickets,
      semiCurrentLines,
      semiSlipQueue,
      lastSavedAt,
    });
  }, [sheetIntent, picked, bulkTickets, semiCurrentLines, semiSlipQueue, lastSavedAt]);

  /** 다음 저장 시 부여될 라벨 — currentSlipLines 의 크기로 결정. */
  const currentLabel: GameLabel =
    GAME_LABELS[semiCurrentLines.length] ?? GAME_LABELS[0];

  const latest = useQuery({
    queryKey: ['v1-latest-for-semi-auto'],
    queryFn: v1Api.getLatestDraw,
    staleTime: 60_000,
    enabled: compareWinning,
  });

  // 메타 — 최신 회차 가져오기 (회차 선택 상한 클램프용)
  const meta = useQuery({
    queryKey: ['v1-meta-for-semi-auto'],
    queryFn: v1Api.getMeta,
    staleTime: 60_000,
  });
  const latestRound = latestRoundProp ?? meta.data?.latest_round ?? null;

  const selectedRoundQuery = useQuery({
    queryKey: ['v1-round-for-semi-auto', compareRound],
    queryFn: () => v1Api.getRound(compareRound as number),
    enabled: compareWinning && !!compareRound,
    staleTime: 60_000,
    retry: false,
  });

  const comparisonRoundData = compareWinning
    ? compareRound != null
      ? selectedRoundQuery.data
      : latest.data
    : null;
  const effectiveRound = compareWinning
    ? compareRound ?? latest.data?.round ?? latestRound
    : currentRound;

  const winningNumbers = compareWinning ? (comparisonRoundData?.numbers ?? []) : [];
  const winningBonus = compareWinning ? (comparisonRoundData?.bonus ?? null) : null;

  const intentSectionLabel = sheetIntent === 'review' ? '복기' : '이번회차';

  const autoOnlyLines = useMemo(
    () => collectAutoOnlyLines(currentSlipLines, slipQueue, bulkAutoTickets),
    [currentSlipLines, slipQueue, bulkAutoTickets]
  );
  const autoLineCountEstimate = autoOnlyLines.length;
  const semiLineCountEstimate =
    semiCurrentLines.length +
    semiSlipQueue.reduce((sum, slip) => sum + slip.lines.length, 0) +
    bulkTickets.length;
  const combinedTicketEstimate = autoLineCountEstimate + semiLineCountEstimate;
  const estimatedLinePairCount = autoLineCountEstimate * semiLineCountEstimate;
  const suspendHeavyComparison =
    combinedTicketEstimate > HEAVY_COMPARISON_TICKET_LIMIT ||
    estimatedLinePairCount > HEAVY_LINE_PAIR_LIMIT;

  const strongCandidateResolution = useMemo(
    () => resolveStrongCandidates(accumulated, sheetIntent, autoOnlyLines, winningNumbers),
    [accumulated, sheetIntent, autoOnlyLines, winningNumbers]
  );

  const predictionSignalsQuery = useQuery({
    queryKey: ['v1-prediction-signals', sheetIntent],
    queryFn: () => v1Api.getPredictionSignals(sheetIntent),
    staleTime: 120_000,
    retry: 1,
  });
  const predictionSignals = predictionSignalsQuery.data ?? null;

  const resolvedStrongCandidates = useMemo(() => {
    if (predictionSignals?.strong_candidates?.length) {
      return predictionSignals.strong_candidates;
    }
    return strongCandidateResolution.candidates;
  }, [predictionSignals, strongCandidateResolution.candidates]);

  const resolvedExcludedCandidates = useMemo(() => {
    if (predictionSignals?.excluded_candidates?.length) {
      return predictionSignals.excluded_candidates;
    }
    return getIntentExcludedCandidates(accumulated, sheetIntent);
  }, [predictionSignals, accumulated, sheetIntent]);

  const strongCandidateSource = predictionSignals?.strong_candidates?.length
    ? 'unified-rules'
    : strongCandidateResolution.source;

  const winningSet = useMemo<Set<number> | null>(() => {
    if (!compareWinning || !winningNumbers.length) return null;
    return new Set(winningNumbers);
  }, [compareWinning, winningNumbers]);

  const qc = useQueryClient();
  const [isReanalyzing, setIsReanalyzing] = useState(false);
  const [reanalyzeNotice, setReanalyzeNotice] = useState<string | null>(null);

  const handleReanalyze = useCallback(async () => {
    if (isReanalyzing) return;
    setIsReanalyzing(true);
    setReanalyzeNotice(null);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['v1-latest-for-semi-auto'] }),
        qc.invalidateQueries({ queryKey: ['v1-meta-for-semi-auto'] }),
        qc.invalidateQueries({ queryKey: ['v1-round-for-semi-auto'] }),
        qc.refetchQueries({ queryKey: ['v1-latest-for-semi-auto'] }),
        qc.refetchQueries({ queryKey: ['v1-meta-for-semi-auto'] }),
        compareRound != null
          ? qc.refetchQueries({ queryKey: ['v1-round-for-semi-auto', compareRound] })
          : Promise.resolve(),
      ]);
      if (onRefreshAccumulated) {
        await onRefreshAccumulated();
      }
      await qc.invalidateQueries({ queryKey: ['v1-prediction-signals', sheetIntent] });
      await qc.refetchQueries({ queryKey: ['v1-prediction-signals', sheetIntent] });
      setRecommendations([]);
      setReanalyzeNotice('✅ 재분석 완료 — 당첨번호·서버 누적·통계를 갱신했습니다.');
    } catch (e) {
      setReanalyzeNotice(
        `❌ 재분석 실패: ${e instanceof Error ? e.message : '서버 오류'}`
      );
    } finally {
      setIsReanalyzing(false);
    }
  }, [compareRound, isReanalyzing, onRefreshAccumulated, qc, sheetIntent]);

  // UI 토글 상태
  const [showAllTickets, setShowAllTickets] = useState(false);
  const [showBacktestTop, setShowBacktestTop] = useState(false);
  const [recommendations, setRecommendations] = useState<ScoredRecommendation[]>([]);
  // [추천 5세트 생성] 클릭마다 증가 — 같은 데이터에서도 매번 다른 5세트 생성.
  const regenNonceRef = useRef(0);

  const togglePick = (n: number) => {
    if (picked.includes(n)) {
      setPicked(picked.filter((x) => x !== n));
    } else if (picked.length < 6) {
      const sorted = [...picked, n].sort((a, b) => a - b);
      setPicked(sorted);
    }
  };

  const reset = () => {
    setPicked([]);
    setSaveNotice(null);
  };

  /** 동일 6-튜플 중복 검사 — 현재 입력 중 + 누적 용지 전체 대상. */
  const findDuplicateLocation = (
    sorted: number[]
  ): { foundIn: 'current'; lineLabel: GameLabel } | { foundIn: 'queue'; slipIdx: number; lineLabel: GameLabel } | null => {
    const key = sorted.join('-');
    for (const line of semiCurrentLines) {
      if ([...line.numbers].sort((a, b) => a - b).join('-') === key) {
        return { foundIn: 'current', lineLabel: line.label };
      }
    }
    for (let slipIdx = 0; slipIdx < semiSlipQueue.length; slipIdx++) {
      for (const line of semiSlipQueue[slipIdx].lines) {
        if ([...line.numbers].sort((a, b) => a - b).join('-') === key) {
          return { foundIn: 'queue', slipIdx, lineLabel: line.label as GameLabel };
        }
      }
    }
    return null;
  };

  /**
   * picked 6개 → semiCurrentLines 에 append.
   * 5줄 완성되면 semiSlipQueue 로 묶고 currentLines 비움 (자동 패턴 동일).
   */
  const saveCurrentLine = () => {
    if (picked.length !== 6) return;
    const sorted = [...picked].sort((a, b) => a - b);
    const dup = findDuplicateLocation(sorted);
    if (dup) {
      const where =
        dup.foundIn === 'current'
          ? `입력 중인 ${dup.lineLabel}줄`
          : `용지 ${dup.slipIdx + 1}의 ${dup.lineLabel}줄`;
      setSaveNotice(`⚠ 이미 저장된 동일 줄입니다 (${where}).`);
      return;
    }
    const newLine: SavedLine = { label: currentLabel, numbers: sorted };
    const nextLines = [...semiCurrentLines, newLine];
    if (nextLines.length >= GAME_LABELS.length) {
      // 5줄 완성 → 용지로 묶고 입력 중 비우기
      setSemiSlipQueue((prev) => [...prev, { lines: nextLines }]);
      setSemiCurrentLines([]);
      setSaveNotice(`✅ 용지 ${semiSlipQueue.length + 1}장 완성 — ${currentLabel}줄 저장 완료.`);
    } else {
      setSemiCurrentLines(nextLines);
      const nextLabel = GAME_LABELS[nextLines.length];
      setSaveNotice(`✅ ${currentLabel}줄 저장 — 다음 ${nextLabel}줄.`);
    }
    setPicked([]);
  };

  /** 입력 중 줄 단건 삭제 + 라벨 재정렬. */
  const removeCurrentLine = (idx: number) => {
    const removed = semiCurrentLines[idx];
    const next = semiCurrentLines
      .filter((_, i) => i !== idx)
      .map((l, i) => ({ ...l, label: GAME_LABELS[i] }));
    setSemiCurrentLines(next);
    if (removed) {
      setSaveNotice(
        `${removed.label}줄 삭제 — 다음 입력은 ${GAME_LABELS[next.length] ?? 'A'}줄.`
      );
    }
  };

  /** 입력 중 줄 → picked 로 복원 (재편집). 그 줄은 누적에서 제거. */
  const editCurrentLine = (idx: number) => {
    const target = semiCurrentLines[idx];
    if (!target) return;
    setPicked([...target.numbers].sort((a, b) => a - b));
    const next = semiCurrentLines
      .filter((_, i) => i !== idx)
      .map((l, i) => ({ ...l, label: GAME_LABELS[i] }));
    setSemiCurrentLines(next);
    setSaveNotice(`${target.label}줄 수정 모드 — 변경 후 [줄 저장].`);
  };

  /** 누적 용지 1장 통째 삭제. */
  const removeSlip = (slipIdx: number) => {
    setSemiSlipQueue((prev) => prev.filter((_, i) => i !== slipIdx));
  };

  /** 누적 용지의 1줄만 삭제 + 그 용지 내부 라벨 재정렬. */
  const removeSlipLine = (slipIdx: number, lineIdx: number) => {
    setSemiSlipQueue((prev) =>
      prev
        .map((slip, sIdx) => {
          if (sIdx !== slipIdx) return slip;
          const nextLines = slip.lines
            .filter((_, lIdx) => lIdx !== lineIdx)
            .map((l, li) => ({ ...l, label: GAME_LABELS[li] }));
          return { lines: nextLines };
        })
        .filter((slip) => slip.lines.length > 0)
    );
  };

  /**
   * 반자동 누적 전체 삭제 — 저장 줄(semi*) + 대량(bulkTickets) + 마지막
   * 저장 시각까지. picked (입력 중 그리드 선택) 는 누적이 아니므로 제외.
   */
  const clearAllSaved = async () => {
    const savedTotalLines =
      semiCurrentLines.length + semiSlipQueue.reduce((s, sl) => s + sl.lines.length, 0);
    const bulkCount = bulkTickets.length;
    if (savedTotalLines === 0 && bulkCount === 0) return;
    const parts: string[] = [];
    if (semiSlipQueue.length > 0) parts.push(`저장 ${semiSlipQueue.length}장`);
    if (semiCurrentLines.length > 0) parts.push(`입력 중 ${semiCurrentLines.length}줄`);
    if (bulkCount > 0) parts.push(`대량 ${bulkCount}장`);
    const ok = await confirm({
      message: `반자동 누적 (${parts.join(' + ')}) 을 모두 삭제할까요?`,
      destructive: true,
      confirmText: '전체 삭제',
    });
    if (!ok) return;
    setSemiCurrentLines([]);
    setSemiSlipQueue([]);
    setBulkTickets([]);
    setLastSavedAt(null);
    setSaveNotice('반자동 누적이 모두 삭제되었습니다.');
  };

  /** 입력 중인 용지 (picked + semiCurrentLines) 만 비움 — semiSlipQueue 보존. */
  const resetCurrentSlip = () => {
    if (picked.length === 0 && semiCurrentLines.length === 0) return;
    setPicked([]);
    setSemiCurrentLines([]);
    setSaveNotice('입력 중인 용지를 초기화했습니다.');
  };

  /**
   * [누적·저장] — 백엔드 저장 + localStorage 이중 영속.
   * - semiSlipQueue(완성 용지) + semiCurrentLines(부분 용지) + bulkTickets(대량) 모두 포함
   * - 저장 후 semiSlipQueue/semiCurrentLines 초기화 (bulkTickets 는 유지)
   * - accumulated 갱신 콜백으로 상위 컴포넌트에 결과 전달
   */
  const confirmAccumulate = useCallback(async () => {
    // 저장 대상 집계
    let slips: ManualSlipInput[] = [...semiSlipQueue];
    if (semiCurrentLines.length > 0) {
      slips = [...slips, { lines: semiCurrentLines }];
    }
    // bulkTickets도 5줄씩 묶어서 포함
    for (let i = 0; i < bulkTickets.length; i += GAME_LABELS.length) {
      const chunk = bulkTickets.slice(i, i + GAME_LABELS.length);
      const chunkLines: SavedLine[] = chunk.map((numbers, idx) => ({
        label: GAME_LABELS[idx],
        numbers,
      }));
      slips.push({ lines: chunkLines });
    }

    if (slips.length === 0) {
      setSaveNotice('⚠ 저장할 번호가 없습니다. 그리드에서 줄 저장 또는 대량 입력을 먼저 하세요.');
      return;
    }

    setIsSaving(true);
    setSaveNotice(null);
    try {
      // 현재 탭 intent 로 저장
      const res = await v1Api.analyzeManualSlips(slips, {
        sheetIntent,
        persist: true,
      });
      if (!mountedRef.current) return;

      const totalLines = slips.reduce((s, sl) => s + sl.lines.length, 0);
      if (res.accumulated) {
        onAccumulatedChange?.(res.accumulated);
      }
      if (res.duplicate_skipped) {
        setSaveNotice(`⚠ 이미 등록된 용지입니다: ${res.duplicate_message ?? ''} 입력 데이터는 유지됩니다.`);
      } else {
        const nowIso = new Date().toISOString();
        setLastSavedAt(nowIso);
        // 저장 성공 시 '줄 저장' 누적(완성/부분 용지)만 비운다.
        // 대량 입력(bulkTickets)은 유지 — §1 자동(bulkAutoTickets)과 동일하게,
        // 저장 후에도 추가 세팅 목록·비교에 계속 표시돼 누적번호를 확인할 수 있다.
        // (재저장 시 동일 용지는 백엔드 source_id 중복으로 걸러진다.)
        setSemiSlipQueue([]);
        setSemiCurrentLines([]);
        setSaveNotice(
          `✅ ${slips.length}장 (${totalLines}줄) 백엔드 저장 완료. 대량 입력은 아래 목록에 유지됩니다.`
        );
      }
      // 상위에서 accumulated 를 갱신할 수 있도록 query 무효화
      qc.invalidateQueries({ queryKey: ['photo-analysis-accumulated'] });
    } catch (e) {
      if (!mountedRef.current) return;
      setSaveNotice(
        `❌ 저장 실패: ${e instanceof Error ? e.message : '서버 오류'}. 데이터는 localStorage에 보존됩니다.`
      );
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, [semiSlipQueue, semiCurrentLines, bulkTickets, onAccumulatedChange, qc, sheetIntent]);

  const comparison = useMemo(
    () =>
      buildComparison(
        picked,
        {},
        slipQueue,
        accumulated,
        sheetIntent,
        winningNumbers,
        winningBonus,
        resolvedStrongCandidates
      ),
    [picked, slipQueue, accumulated, sheetIntent, winningNumbers, winningBonus, resolvedStrongCandidates]
  );

  // 경량 비교(상세 교집합/요약)는 보류 중이라도 [상세 비교 보기] 강제 시
  // 상위 캡만큼만 계산해 표시. 무거운 1:1 전수비교는 별도(아래)에서 보류 유지.
  const lightComparisonSuspended = suspendHeavyComparison && !forceDetailedComparison;

  const bulkComparison = useMemo(
    () => {
      if (lightComparisonSuspended || bulkTickets.length === 0) return null;
      const cmpTickets = suspendHeavyComparison
        ? bulkTickets.slice(0, FORCE_DETAILED_TICKET_CAP)
        : bulkTickets;
      return buildBulkComparison(
        cmpTickets,
        slipQueue,
        accumulated,
        winningNumbers,
        winningBonus,
        sheetIntent,
        resolvedStrongCandidates
      );
    },
    [bulkTickets, slipQueue, accumulated, winningNumbers, winningBonus, sheetIntent, resolvedStrongCandidates, lightComparisonSuspended, suspendHeavyComparison]
  );

  /**
   * 자동 + 반자동 통합 비교 — 강한 후보 교집합 패널 전용.
   * 자동 (currentSlipLines + slipQueue + bulkAutoTickets) + 반자동
   * (semiCurrentLines + semiSlipQueue + bulkTickets) 의 모든 줄을 합쳐
   * '이번회차 자동 누적 강한 후보' 와의 교집합 세트를 모두 통계.
   * 사용자 요청: '전체 티켓 목록에서 자동과 반자동의 교집합 세트 번호는
   * 모두 나올 수 있도록 통계 분석'.
   */
  const combinedTickets = useMemo<number[][]>(() => {
    const out: number[][] = [];
    for (const line of currentSlipLines) out.push(line.numbers);
    for (const slip of slipQueue) {
      for (const line of slip.lines) out.push(line.numbers);
    }
    for (const ticket of bulkAutoTickets) out.push(ticket);
    for (const line of semiCurrentLines) out.push(line.numbers);
    for (const slip of semiSlipQueue) {
      for (const line of slip.lines) out.push(line.numbers);
    }
    for (const ticket of bulkTickets) out.push(ticket);
    return out;
  }, [currentSlipLines, slipQueue, bulkAutoTickets, semiCurrentLines, semiSlipQueue, bulkTickets]);

  const combinedComparison = useMemo(
    () => {
      if (lightComparisonSuspended || combinedTickets.length === 0) return null;
      const cmpTickets = suspendHeavyComparison
        ? combinedTickets.slice(0, FORCE_DETAILED_TICKET_CAP)
        : combinedTickets;
      return buildBulkComparison(
        cmpTickets,
        slipQueue,
        accumulated,
        winningNumbers,
        winningBonus,
        sheetIntent,
        resolvedStrongCandidates
      );
    },
    [combinedTickets, slipQueue, accumulated, winningNumbers, winningBonus, sheetIntent, resolvedStrongCandidates, lightComparisonSuspended, suspendHeavyComparison]
  );

  /**
   * 강한 후보 교집합 패널 전용 alias.
   * 자동+반자동 통합 통계 (combinedComparison) 우선, 없을 때만 bulkComparison
   * 으로 폴백.
   */
  const activeComparison = combinedComparison ?? bulkComparison;
  const intersectionCmp = activeComparison!;

  /**
   * 자동 그룹의 각 줄 ↔ 반자동 그룹의 각 줄 1:1 전수 비교 매칭.
   * 사용자 정정 (최종 명세):
   * - 자동 (currentSlipLines + slipQueue + bulkAutoTickets) 평탄화 후
   *   '자동 #1, #2, ...' 일련번호 부여.
   * - 반자동 (semiCurrentLines + semiSlipQueue + bulkTickets) 평탄화 후
   *   '반자동 #1, #2, ...' 일련번호 부여.
   * - 모든 (자동 줄, 반자동 줄) 페어를 만들고, 두 줄 사이 공통 번호 개수
   *   (matchCount) 가 2~6 인 경우만 누적.
   * - 일치 개수별 (6 → 5 → 4 → 3 → 2) 영역으로 분리, 모두 노출.
   *
   * 표기 예시: '[자동 #112] 11 19 26 29 44 45 ↔ [반자동 #36] 4 11 12 26 29 44
   *           (4개 일치: 11, 26, 29, 44)'.
   *
   * 직전 (오해): 줄에서 추출 가능한 모든 부분 조합 (2/3/4/5/6 번호짜리) 의
   * 합집합 빈도를 통계 → 1~45 전체 모집단에서 455종 같은 큰 수가 나옴.
   * 사용자 정정: '줄 1:1 비교' 가 맞음. 부분 조합 분석은 제거하고 줄 페어
   * 매칭으로 교체.
   */
  const groupLineMatching = useMemo(() => {
    if (suspendHeavyComparison) {
      return {
        autoLineCount: autoLineCountEstimate,
        semiLineCount: semiLineCountEstimate,
        autoDupRemoved: 0,
        semiDupRemoved: 0,
        autoDupSamples: [] as string[],
        semiDupSamples: [] as string[],
        totalPairCount: estimatedLinePairCount,
        groups6: [] as LineMatchGroup[],
        groups5: [] as LineMatchGroup[],
        groups4: [] as LineMatchGroup[],
        groups3: [] as LineMatchGroup[],
        groups2: [] as LineMatchGroup[],
        rawPairCount: 0,
        groupCount: 0,
        strongCandidateCount: resolvedStrongCandidates.length,
        strongDist: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } as Record<number, number>,
        strongAvailable: resolvedStrongCandidates.length > 0,
      };
    }
    type LineRef = { idx: number; numbers: number[]; sourceLabel: string };
    type PairMatch = {
      autoIdx: number;
      autoLabel: string;
      autoNumbers: number[];
      semiIdx: number;
      semiLabel: string;
      semiNumbers: number[];
      matchCount: number;
      matchedNumbers: number[];
    };

    const sanitize = (line: number[]): number[] =>
      Array.from(new Set(line.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45))).sort(
        (a, b) => a - b
      );

    /**
     * 6-튜플 키 기준 dedupe — 같은 6번호 줄이 한 그룹 안에 여러 번 들어가
     * 있으면 첫 번째만 유지. 페어 매칭 결과에 '같은 자동 줄 ↔ 같은 반자동
     * 줄' 페어가 다른 인덱스로 두 번 표시되는 것을 차단.
     */
    const dedupeBySixTuple = (refs: LineRef[]): { unique: LineRef[]; dupCount: number; dupSources: string[] } => {
      const seen = new Map<string, string>();  // key → 처음 등장한 sourceLabel
      const unique: LineRef[] = [];
      const dupSources: string[] = [];
      for (const ref of refs) {
        const key = ref.numbers.join('-');
        if (seen.has(key)) {
          dupSources.push(`${ref.sourceLabel} (= ${seen.get(key)})`);
          continue;
        }
        seen.set(key, ref.sourceLabel);
        unique.push(ref);
      }
      // unique 안의 idx 를 평탄 순서 기준으로 재부여.
      unique.forEach((ref, i) => (ref.idx = i + 1));
      return { unique, dupCount: dupSources.length, dupSources };
    };

    // 자동 그룹 평탄화 (raw) — 일단 평탄 순서대로 임시 idx + 소스 라벨.
    const autoRaw: LineRef[] = [];
    for (const line of currentSlipLines) {
      autoRaw.push({ idx: 0, numbers: sanitize(line.numbers), sourceLabel: `입력 중·${line.label}` });
    }
    for (let sIdx = 0; sIdx < slipQueue.length; sIdx += 1) {
      for (const line of slipQueue[sIdx].lines) {
        autoRaw.push({
          idx: 0,
          numbers: sanitize(line.numbers),
          sourceLabel: `용지${sIdx + 1}·${line.label}`,
        });
      }
    }
    for (let bi = 0; bi < bulkAutoTickets.length; bi += 1) {
      autoRaw.push({
        idx: 0,
        numbers: sanitize(bulkAutoTickets[bi]),
        sourceLabel: `대량 #${bi + 1}`,
      });
    }

    // 반자동 그룹 raw.
    const semiRaw: LineRef[] = [];
    for (const line of semiCurrentLines) {
      semiRaw.push({ idx: 0, numbers: sanitize(line.numbers), sourceLabel: `입력 중·${line.label}` });
    }
    for (let sIdx = 0; sIdx < semiSlipQueue.length; sIdx += 1) {
      for (const line of semiSlipQueue[sIdx].lines) {
        semiRaw.push({
          idx: 0,
          numbers: sanitize(line.numbers),
          sourceLabel: `용지${sIdx + 1}·${line.label}`,
        });
      }
    }
    for (let bi = 0; bi < bulkTickets.length; bi += 1) {
      semiRaw.push({
        idx: 0,
        numbers: sanitize(bulkTickets[bi]),
        sourceLabel: `대량 #${bi + 1}`,
      });
    }

    // 양 그룹 dedupe + idx 재부여.
    const autoDedup = dedupeBySixTuple(autoRaw);
    const semiDedup = dedupeBySixTuple(semiRaw);
    const autoLines = autoDedup.unique;
    const semiLines = semiDedup.unique;

    // 자동 × 반자동 페어 전수 매칭. matchCount >= 2 인 페어만 누적.
    const pairs: PairMatch[] = [];
    for (const auto of autoLines) {
      const autoSet = new Set(auto.numbers);
      for (const semi of semiLines) {
        const matched: number[] = [];
        for (const n of semi.numbers) if (autoSet.has(n)) matched.push(n);
        if (matched.length < 2) continue;
        pairs.push({
          autoIdx: auto.idx,
          autoLabel: auto.sourceLabel,
          autoNumbers: auto.numbers,
          semiIdx: semi.idx,
          semiLabel: semi.sourceLabel,
          semiNumbers: semi.numbers,
          matchCount: matched.length,
          matchedNumbers: matched.sort((a, b) => a - b),
        });
      }
    }

    /**
     * matchedNumbers 단위 그룹화 — 사용자 정정 (2차):
     * '자동 측도 일치줄 있으면 중복되지 않도록 매치번호로'.
     * 같은 매치 번호를 갖는 모든 자동 줄과 모든 반자동 줄을 한 카드로 통합.
     * 한 그룹 항목: { matchedNumbers, autoList[], semiList[] }.
     */
    const groupMap = new Map<string, LineMatchGroup>();
    for (const p of pairs) {
      const key = p.matchedNumbers.join('-');
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          matchCount: p.matchCount,
          matchedNumbers: p.matchedNumbers,
          autoList: [],
          semiList: [],
        });
      }
      const g = groupMap.get(key)!;
      if (!g.autoList.some((a) => a.idx === p.autoIdx)) {
        g.autoList.push({ idx: p.autoIdx, label: p.autoLabel, numbers: p.autoNumbers });
      }
      if (!g.semiList.some((s) => s.idx === p.semiIdx)) {
        g.semiList.push({ idx: p.semiIdx, label: p.semiLabel, numbers: p.semiNumbers });
      }
    }
    // 강한 후보 (이번회차 자동 누적) — 매치 번호 중 강한 후보 개수가 통계 핵심.
    const strongCandidates = resolvedStrongCandidates;
    const strongSet = new Set(strongCandidates);

    // 카운터 정의:
    //   winCount(g): 매치 번호 중 당첨번호 개수 (복기 탭).
    //   strongMatchCount(g): 매치 번호 중 강한 후보 개수 (이번회차 탭).
      const winCount = (g: LineMatchGroup): number =>
      winningSet ? g.matchedNumbers.filter((n) => winningSet.has(n)).length : 0;
    const strongMatchCount = (g: LineMatchGroup): number =>
      g.matchedNumbers.filter((n) => strongSet.has(n)).length;
    const lineWinCount = (line: MatchedLineEntry): number =>
      winningSet ? line.numbers.filter((n) => winningSet.has(n)).length : 0;
    const lineStrongCount = (line: MatchedLineEntry): number =>
      line.numbers.filter((n) => strongSet.has(n)).length;

    // 정렬:
    //   복기 탭 (winningSet 존재): 당첨 일치 1순위 → 강한 후보 일치 → matchCount.
    //   이번회차 탭 (winningSet null): 강한 후보 일치 1순위 → matchCount.
    const groups = Array.from(groupMap.values()).sort((x, y) => {
      if (winningSet) {
        const dw = winCount(y) - winCount(x);
        if (dw !== 0) return dw;
      }
      const ds = strongMatchCount(y) - strongMatchCount(x);
      if (ds !== 0) return ds;
      return (
        y.matchCount - x.matchCount ||
        (x.matchedNumbers[0] ?? 0) - (y.matchedNumbers[0] ?? 0) ||
        (x.matchedNumbers[1] ?? 0) - (y.matchedNumbers[1] ?? 0) ||
        y.autoList.length - x.autoList.length ||
        y.semiList.length - x.semiList.length
      );
    });
    // 각 그룹 내부 list 정렬 — 복기는 당첨 일치 1순위, 이번회차는 강한 후보 1순위.
    for (const g of groups) {
      if (winningSet) {
        g.autoList.sort(
          (a, b) =>
            lineWinCount(b) - lineWinCount(a) ||
            lineStrongCount(b) - lineStrongCount(a) ||
            a.idx - b.idx
        );
        g.semiList.sort(
          (a, b) =>
            lineWinCount(b) - lineWinCount(a) ||
            lineStrongCount(b) - lineStrongCount(a) ||
            a.idx - b.idx
        );
      } else {
        g.autoList.sort(
          (a, b) => lineStrongCount(b) - lineStrongCount(a) || a.idx - b.idx
        );
        g.semiList.sort(
          (a, b) => lineStrongCount(b) - lineStrongCount(a) || a.idx - b.idx
        );
      }
    }

    // 강한 후보 일치 분포 (matchedNumbers 의 강한 후보 개수별 그룹 카운트).
    const strongDist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const g of groups) {
      const k = strongMatchCount(g);
      strongDist[k] = (strongDist[k] ?? 0) + 1;
    }

    return {
      autoLineCount: autoLines.length,
      semiLineCount: semiLines.length,
      autoDupRemoved: autoDedup.dupCount,
      semiDupRemoved: semiDedup.dupCount,
      autoDupSamples: autoDedup.dupSources.slice(0, 5),
      semiDupSamples: semiDedup.dupSources.slice(0, 5),
      totalPairCount: autoLines.length * semiLines.length,
      groups6: groups.filter((g) => g.matchCount === 6),
      groups5: groups.filter((g) => g.matchCount === 5),
      groups4: groups.filter((g) => g.matchCount === 4),
      groups3: groups.filter((g) => g.matchCount === 3),
      groups2: groups.filter((g) => g.matchCount === 2),
      rawPairCount: pairs.length,
      groupCount: groups.length,
      strongCandidateCount: strongCandidates.length,
      strongDist,
      strongAvailable: strongCandidates.length > 0,
    };
  }, [
    currentSlipLines,
    slipQueue,
    bulkAutoTickets,
    semiCurrentLines,
    semiSlipQueue,
    bulkTickets,
    winningSet,
    accumulated,
    sheetIntent,
    resolvedStrongCandidates,
    suspendHeavyComparison,
    autoLineCountEstimate,
    semiLineCountEstimate,
    estimatedLinePairCount,
  ]);
  const hasLineMatchingInputs = groupLineMatching.autoLineCount > 0 || groupLineMatching.semiLineCount > 0;
  const canRenderLineMatching = groupLineMatching.autoLineCount > 0 && groupLineMatching.semiLineCount > 0;
  const lineMatchNumber = lineMatchNumberFilter ? Number(lineMatchNumberFilter) : null;
  const filterLineMatchGroups = <T extends { matchCount: number; matchedNumbers: number[] }>(groups: T[]): T[] =>
    groups.filter((g) => {
      if (lineMatchFilter !== 'all' && g.matchCount !== lineMatchFilter) return false;
      if (lineMatchNumber != null && !g.matchedNumbers.includes(lineMatchNumber)) return false;
      return true;
    });
  const visibleGroupMatch6 = filterLineMatchGroups(groupLineMatching.groups6);
  const visibleGroupMatch5 = filterLineMatchGroups(groupLineMatching.groups5);
  const visibleGroupMatch4 = filterLineMatchGroups(groupLineMatching.groups4);
  const visibleGroupMatch3 = filterLineMatchGroups(groupLineMatching.groups3);
  const visibleGroupMatch2 = filterLineMatchGroups(groupLineMatching.groups2);
  const visibleGroupMatchTotal =
    visibleGroupMatch6.length +
    visibleGroupMatch5.length +
    visibleGroupMatch4.length +
    visibleGroupMatch3.length +
    visibleGroupMatch2.length;

  const generateRecommendations = useCallback(() => {
    const semiFreq: Record<number, number> = {};
    for (const n of [
      ...bulkTickets.flat(),
      ...semiSlipQueue.flatMap((sl) => sl.lines.flatMap((l) => l.numbers)),
      ...semiCurrentLines.flatMap((l) => l.numbers),
    ]) {
      if (Number.isInteger(n) && n >= 1 && n <= 45) {
        semiFreq[n] = (semiFreq[n] ?? 0) + 1;
      }
    }

    const autoFreq: Record<number, number> = {};
    for (const line of autoOnlyLines) {
      for (const n of line) {
        if (Number.isInteger(n) && n >= 1 && n <= 45) {
          autoFreq[n] = (autoFreq[n] ?? 0) + 1;
        }
      }
    }

    const cmp = activeComparison;
    const lineMatchGroups = [
      ...groupLineMatching.groups6,
      ...groupLineMatching.groups5,
      ...groupLineMatching.groups4,
      ...groupLineMatching.groups3,
      ...groupLineMatching.groups2,
    ].map((g) => ({
      matchCount: g.matchCount,
      matchedNumbers: g.matchedNumbers,
      cardWeight: g.autoList.length + g.semiList.length,
    }));

    const seedTickets: {
      ticket: number[];
      weight: number;
      label: string;
    }[] = [];
    if (cmp) {
      for (const t of cmp.bestTickets) {
        seedTickets.push({
          ticket: t.ticket,
          weight: 12 + t.vsLatestMatch.length * 3 + t.vsStrongMatch.length,
          label: '당첨매치상위',
        });
      }
      for (const t of cmp.bestComboTickets) {
        seedTickets.push({
          ticket: t.ticket,
          weight: 10 + t.comboScore,
          label: '콤보상위',
        });
      }
      const ticketSeeds = [...cmp.perTicket]
        .filter(
          (t) =>
            t.comboScore > 0 ||
            t.vsStrongMatch.length >= 3 ||
            (compareWinning && t.vsLatestMatch.length >= 3)
        )
        .sort(
          (a, b) =>
            b.comboScore +
            b.vsStrongMatch.length * 2 +
            b.vsLatestMatch.length * 3 -
            (a.comboScore + a.vsStrongMatch.length * 2 + a.vsLatestMatch.length * 3)
        )
        .slice(0, 25);
      for (const t of ticketSeeds) {
        seedTickets.push({
          ticket: t.ticket,
          weight: 6 + t.comboScore + t.vsStrongMatch.length,
          label: '통계상위티켓',
        });
      }
    }

    const nonce = regenNonceRef.current;
    regenNonceRef.current = nonce + 1; // 다음 클릭은 다른 세트
    const results = generateScoredRecommendations(
      {
        sheetIntent,
        strongCandidates: resolvedStrongCandidates,
        excludedCandidates: resolvedExcludedCandidates,
        winningNumbers: compareWinning ? winningNumbers : [],
        comboPatterns: getIntentComboPatterns(accumulated, sheetIntent),
        semiFreq,
        autoFreq,
        intersection: cmp
          ? {
              two: cmp.twoIntersectionGroups,
              three: cmp.threeIntersectionGroups,
              fourPlus: cmp.fourPlusIntersectionGroups,
            }
          : { two: [], three: [], fourPlus: [] },
        lineMatchGroups,
        seedTickets,
        unifiedSignals: predictionSignals?.ranked_numbers?.map((r) => ({
          number: r.number,
          grade: r.grade,
          score: r.score,
          sources: r.sources,
        })),
        regenNonce: nonce,
      },
      5
    );
    setRecommendations(results);
  }, [
    accumulated,
    activeComparison,
    autoOnlyLines,
    bulkTickets,
    compareWinning,
    groupLineMatching.groups2,
    groupLineMatching.groups3,
    groupLineMatching.groups4,
    groupLineMatching.groups5,
    groupLineMatching.groups6,
    resolvedStrongCandidates,
    semiCurrentLines,
    semiSlipQueue,
    sheetIntent,
    winningNumbers,
    predictionSignals,
    resolvedExcludedCandidates,
  ]);

  /**
   * 대량 입력 — append + dedup.
   *
   * 이전: setBulkTickets(lines) 가 모두 덮어씀
   * 이후: 기존 bulkTickets 에 new lines 를 append, 중복(같은 6-튜플) 제거.
   * → 매번 새로 입력해도 사라지지 않고 누적됨 (사용자 요청).
   * → 명시 초기화 ('대량 결과 초기화') 시에만 비워짐.
   */
  const handleBulkInsert = (lines: number[][]) => {
    if (!lines.length) return;
    let addedCount = 0;
    let dupCount = 0;
    setBulkTickets((prev) => {
      const existingKeys = new Set(
        prev.map((t) => [...t].sort((a, b) => a - b).join('-'))
      );
      const merged = [...prev];
      for (const line of lines) {
        const key = [...line].sort((a, b) => a - b).join('-');
        if (existingKeys.has(key)) {
          dupCount += 1;
          continue;
        }
        existingKeys.add(key);
        merged.push([...line].sort((a, b) => a - b));
        addedCount += 1;
      }
      return merged;
    });
    // 대량 입력 후 안내 메시지 (다음 렌더 후 반영)
    setTimeout(() => {
      const msg = addedCount > 0
        ? `✅ ${addedCount}줄 대량 추가 완료. ` +
          (dupCount > 0 ? `중복 ${dupCount}줄 제외. ` : '') +
          `[누적·저장] 버튼으로 백엔드에 저장하면 통계에 반영됩니다.`
        : `⚠ ${dupCount}줄 모두 중복으로 추가된 줄이 없습니다.`;
      setSaveNotice(msg);
    }, 0);
  };

  const resetBulk = () => setBulkTickets([]);

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            🔄 반자동 비교
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {compareWinning
              ? '복기 — 당첨번호·누적 강한후보·교집합 통계 비교'
              : '이번회차 — 줄간 겹침·강한 후보 분석 (당첨번호 미사용)'}
          </Typography>
        </Box>
        <Button
          type="button"
          size="small"
          variant="outlined"
          disabled={isReanalyzing}
          onClick={() => void handleReanalyze()}
          sx={{ flexShrink: 0, minWidth: 88, zIndex: 2 }}
        >
          {isReanalyzing ? (
            <><CircularProgress size={14} sx={{ mr: 0.5 }} />재분석…</>
          ) : (
            '↻ 재분석'
          )}
        </Button>
      </Stack>

      {reanalyzeNotice && (
        <Alert
          severity={reanalyzeNotice.startsWith('❌') ? 'error' : 'success'}
          sx={{ mb: 1.5 }}
          onClose={() => setReanalyzeNotice(null)}
        >
          {reanalyzeNotice}
        </Alert>
      )}

      <Alert severity="warning" icon={false} sx={{ mb: 1.5, fontSize: 12 }}>
        🟡 본 비교는 패턴 관찰 도구입니다. 어떤 일치도 다음 회차의 1/8,145,060 확률을 변경하지 않습니다.
      </Alert>

      {/* 번호 선택 그리드 — 자동(구입번호 직접입력) 패턴과 동일 룩앤필 */}
      <Box sx={{ mb: 1.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle2" fontWeight={700}>
            {currentLabel}줄 · {picked.length}/6
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center">
            {picked.length > 0 && (
              <Button type="button" size="small" onClick={reset}>
                초기화
              </Button>
            )}
            <Button
              type="button"
              size="small"
              variant="contained"
              onClick={saveCurrentLine}
              disabled={picked.length !== 6}
            >
              줄 저장
            </Button>
          </Stack>
        </Stack>
        {picked.length > 0 && (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              {picked
                .slice()
                .sort((a, b) => a - b)
                .map((n) => (
                  <LottoBall key={n} number={n} size={32} neutral />
                ))}
            </Stack>
          )}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            gap: 0.75,
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'action.hover',
          }}
        >
          {NUMBERS.map((n) => {
            const isPicked = picked.includes(n);
            return (
              <Box
                key={n}
                component="button"
                type="button"
                role="checkbox"
                aria-checked={isPicked}
                aria-label={`${n}번${isPicked ? ' 선택됨' : ''}`}
                onClick={() => togglePick(n)}
                sx={{
                  p: 0,
                  border: 'none',
                  background: 'none',
                  font: 'inherit',
                  display: 'flex',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  opacity: isPicked ? 1 : 0.55,
                  transform: isPicked ? 'scale(1.05)' : 'scale(1)',
                  transition: 'transform 0.12s ease, opacity 0.12s ease',
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: 2,
                    borderRadius: '50%',
                  },
                }}
              >
                <LottoBall number={n} size={36} dimmed={!isPicked} neutral />
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* 하단 액션 행 — [용지 초기화] [⬆ 대량 입력] [누적·저장] */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.5 }}>
        <Button
          type="button"
          variant="outlined"
          color="inherit"
          onClick={resetCurrentSlip}
          disabled={picked.length === 0 && semiCurrentLines.length === 0}
        >
          용지 초기화
        </Button>
        <Button
          type="button"
          variant="outlined"
          color="primary"
          onClick={() => setBulkOpen(true)}
        >
          ⬆ 대량 입력 (반자동 500줄+)
        </Button>
        <Button
          type="button"
          variant="contained"
          color="success"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void confirmAccumulate();
          }}
          disabled={isSaving || (
            semiCurrentLines.length === 0 &&
            semiSlipQueue.length === 0 &&
            bulkTickets.length === 0
          )}
          sx={{ minWidth: 160 }}
        >
          {isSaving ? (
            <><CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />저장 중…</>
          ) : (() => {
            const totalLines =
              semiCurrentLines.length +
              semiSlipQueue.reduce((s, sl) => s + sl.lines.length, 0) +
              bulkTickets.length;
            return `💾 누적·저장 (${totalLines}줄)`;
          })()}
        </Button>
      </Stack>

      {saveNotice && (
        <Alert
          severity={saveNotice.startsWith('⚠') ? 'warning' : 'success'}
          sx={{ mb: 1.5 }}
          onClose={() => setSaveNotice(null)}
        >
          {saveNotice}
        </Alert>
      )}

      {suspendHeavyComparison && (
        <Alert
          severity="info"
          sx={{ mb: 1.5 }}
          action={
            !forceDetailedComparison ? (
              <Button
                color="info"
                size="small"
                variant="outlined"
                onClick={() => setForceDetailedComparison(true)}
              >
                상세 비교 보기 (상위 {FORCE_DETAILED_TICKET_CAP}장)
              </Button>
            ) : (
              <Button
                color="inherit"
                size="small"
                onClick={() => setForceDetailedComparison(false)}
              >
                다시 보류
              </Button>
            )
          }
        >
          {forceDetailedComparison ? (
            <>
              상위 {FORCE_DETAILED_TICKET_CAP}장만으로 <strong>상세 교집합·요약 비교</strong>를 표시 중입니다.
              (무거운 1:1 전수비교는 브라우저 보호를 위해 보류 — 줄 수를 줄이면 전체가 표시됩니다.)
            </>
          ) : (
            <>
              대량 입력이 많아 브라우저 보호를 위해 상세 교집합/1:1 전수비교 계산을 잠시 보류합니다.
              저장은 정상 동작하며, <strong>[상세 비교 보기]</strong> 로 상위 일부만 보거나 줄 수를 줄이면 세부 비교가 다시 표시됩니다.
            </>
          )}
        </Alert>
      )}

      {picked.length > 0 && picked.length < 6 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {6 - picked.length}개 더 선택하면 비교 결과가 표시됩니다.
        </Typography>
      )}

      {/* 저장 누적 — 자동의 SavedLinesPanel 그대로 재사용 (A~E · 5줄/용지) */}
      {(semiCurrentLines.length > 0 || semiSlipQueue.length > 0) && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1 }}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>
                💾 저장 누적 — {semiSlipQueue.length}장 · 입력 중 {semiCurrentLines.length}/{GAME_LABELS.length}줄
              </Typography>
              {lastSavedAt && (
                <Typography variant="caption" color="text.secondary">
                  마지막 저장 확정: {new Date(lastSavedAt).toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Typography>
              )}
            </Box>
          </Stack>
          <SavedLinesPanel
            currentSlipLines={semiCurrentLines}
            slipQueue={semiSlipQueue}
            onRemoveSlip={removeSlip}
            onRemoveCurrentLine={removeCurrentLine}
            onEditCurrentLine={editCurrentLine}
            onRemoveSlipLine={removeSlipLine}
            emptyHint="저장된 줄이 없습니다. 그리드에서 6개 선택 후 [줄 저장]."
          />
        </Paper>
      )}

      {/* 추가 세팅 — 반자동 비교 전용. 자동(§1) 의 SavedLinesPanel 직후
          추가 세팅 위치와 동일 구조. 자동/반자동 § 모두 같은 흐름. */}
      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>
        ⚙ 추가 세팅
      </Typography>
      {(() => {
        // 반자동 누적 평탄화 — 자동 §1 추가 세팅과 동일 룩앤필 공유.
        // 데이터 소스: 입력 중 줄 + 저장된 용지 + 대량 입력 (반자동 특유).
        const ticketLines = [
          ...semiCurrentLines.map((line, idx) => ({
            key: `current-${idx}`,
            label: `입력 중·${line.label}`,
            numbers: line.numbers,
            onRemove: () => removeCurrentLine(idx),
          })),
          ...semiSlipQueue.flatMap((slip, slipIdx) =>
            slip.lines.map((line, lineIdx) => ({
              key: `slip-${slipIdx}-${lineIdx}`,
              label: `용지${slipIdx + 1}·${line.label}`,
              numbers: line.numbers,
              onRemove: () => removeSlipLine(slipIdx, lineIdx),
            }))
          ),
          ...bulkTickets.map((ticket, idx) => ({
            key: `bulk-${idx}`,
            label: `대량 #${idx + 1}`,
            numbers: ticket,
            onRemove: () =>
              setBulkTickets((prev) => prev.filter((_, i) => i !== idx)),
          })),
        ];
        return (
          <>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
              <Typography variant="body2">
                반자동 누적: {semiSlipQueue.length}장 · 입력 중 {semiCurrentLines.length}/{GAME_LABELS.length}줄 · 대량 {bulkTickets.length}장 · 총 {ticketLines.length}줄
              </Typography>
              {ticketLines.length > 0 && (
                <Chip
                  size="small"
                  color={lastSavedAt ? 'success' : 'warning'}
                  label={lastSavedAt ? `마지막 저장: ${new Date(lastSavedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '미저장 — [💾 누적·저장] 클릭'}
                  sx={{ fontSize: 11 }}
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              ※ [💾 누적·저장] 클릭 시 백엔드에 저장되어 통계에 반영됩니다. 새로고침 전에 반드시 저장하세요.
              아래 목록의 [×] 로 개별 줄 삭제.
            </Typography>
            {ticketLines.length === 0 ? (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                반자동 누적이 없습니다. 그리드에서 6개 선택 후 [줄 저장] 하거나 [⬆ 대량 입력] 으로 추가하세요.
              </Alert>
            ) : (
              <Box sx={{ maxHeight: 320, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75, mb: 1.5 }}>
                <Stack spacing={0.5}>
                  {ticketLines.map((line, idx) => {
                    const matchCount = winningSet
                      ? line.numbers.filter((n) => winningSet.has(n)).length
                      : 0;
                    return (
                      <Stack
                        key={line.key}
                        direction="row"
                        alignItems="center"
                        spacing={0.5}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Typography variant="caption" sx={{ minWidth: 36, color: 'text.secondary', fontWeight: 600 }}>
                          #{idx + 1}
                        </Typography>
                        <Chip size="small" label={line.label} variant="outlined" sx={{ minWidth: 84 }} />
                        <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                          {line.numbers.map((n) => (
                            <LottoBall
                              key={`${line.key}-${n}`}
                              number={n}
                              size={22}
                              dimmed={winningSet ? !winningSet.has(n) : false}
                            />
                          ))}
                        </Stack>
                        {winningSet && (
                          <Chip
                            size="small"
                            color={matchCount >= 3 ? 'success' : 'default'}
                            label={`${matchCount}/6`}
                            sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                          />
                        )}
                        <IconButton size="small" onClick={line.onRemove} aria-label="삭제" sx={{ ml: 'auto' }}>
                          ×
                        </IconButton>
                      </Stack>
                    );
                  })}
                </Stack>
              </Box>
            )}
            <Stack direction="row" justifyContent="flex-end">
              <Button
                size="small"
                color="error"
                variant="outlined"
                onClick={clearAllSaved}
                disabled={ticketLines.length === 0}
              >
                반자동 누적 전체 삭제
              </Button>
            </Stack>
          </>
        );
      })()}

      {/* 반자동 누적 기반 빈도 — 자동(§2) 과 분리, 반자동 누적만 카운트 */}
      {(semiCurrentLines.length > 0 || semiSlipQueue.length > 0) && (
        <Box sx={{ mb: 1.5 }}>
          <NumberFrequencyPanel
            lines={[
              ...semiCurrentLines.map((l) => l.numbers),
              ...semiSlipQueue.flatMap((s) => s.lines.map((l) => l.numbers)),
            ]}
            winningSet={winningSet}
            sourceLabel="반자동 누적"
            bodyLabel="반자동 누적"
            emptyHint="반자동 누적이 없습니다. 그리드에서 6개 선택 후 [줄 저장] 으로 누적하세요."
          />
        </Box>
      )}

      {/* 비교 결과 */}
      {picked.length === 6 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
            📊 4축 비교 결과
          </Typography>

          {/* 1. vs 최근 당첨 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              justifyContent="space-between"
            >
              <Typography variant="body2" fontWeight={700}>
                🎯 vs 최근 당첨 ({comparison.vsLatest.winningNumbers.join(', ') || '데이터 없음'})
              </Typography>
              {comparison.vsLatest.available && (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  <MatchBadge
                    label="일치"
                    count={comparison.vsLatest.userMatch.length}
                    of={picked.length}
                    color="success"
                  />
                  {comparison.vsLatest.bonusMatch.user && (
                    <Chip size="small" label="🎁 보너스" color="warning" />
                  )}
                </Stack>
              )}
            </Stack>
          </Paper>

          {/* 2. vs 저장된 슬립 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1 }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              💾 vs 저장된 자동 슬립 ({comparison.vsSavedSlips.slipCount}장)
            </Typography>
            {comparison.vsSavedSlips.overlaps.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                겹치는 번호 있는 슬립 없음 (저장된 슬립이 없거나 완전 신규 조합)
              </Typography>
            ) : (
              <Stack spacing={0.5}>
                {comparison.vsSavedSlips.overlaps.map((ov, i) => (
                  <Stack
                    key={`${ov.slipIdx}-${ov.lineLabel}-${i}`}
                    direction="row"
                    spacing={0.75}
                    alignItems="center"
                    flexWrap="wrap"
                  >
                    <Chip
                      size="small"
                      label={`용지 ${ov.slipIdx + 1} · ${ov.lineLabel}줄`}
                      variant="outlined"
                    />
                    {ov.userOverlap.length > 0 && (
                      <Chip
                        size="small"
                        label={`겹침: ${ov.userOverlap.join(', ')}`}
                        sx={{ bgcolor: '#69C8F2', color: '#fff', fontWeight: 700 }}
                      />
                    )}
                  </Stack>
                ))}
              </Stack>
            )}
          </Paper>

          {/* 3. vs 누적 강한 후보 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              justifyContent="space-between"
            >
              <Typography variant="body2" fontWeight={700}>
                🏆 vs 누적 강한 후보{!comparison.vsStrong.available && ' (데이터 없음)'}
              </Typography>
              {comparison.vsStrong.available && (
                <Stack direction="row" spacing={0.5}>
                  <MatchBadge
                    label="일치"
                    count={comparison.vsStrong.userMatch.length}
                    of={picked.length}
                    color="success"
                  />
                </Stack>
              )}
            </Stack>
            {!comparison.vsStrong.available && (
              <Typography variant="caption" color="text.secondary">
                ※ 용지 분석 누적 데이터가 없습니다. 다른 용지를 등록하면 강한 후보가 산출됩니다.
              </Typography>
            )}
          </Paper>

          {/* 4. vs 누적 배제 후보 */}
          <Paper
            variant="outlined"
            sx={{
              p: 1.5,
              mb: 1,
              borderColor: comparison.vsExcluded.warning ? 'error.main' : undefined,
            }}
          >
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              justifyContent="space-between"
            >
              <Typography
                variant="body2"
                fontWeight={700}
                color={comparison.vsExcluded.warning ? 'error.main' : undefined}
              >
                ⛔ vs 누적 배제 후보{!comparison.vsExcluded.available && ' (데이터 없음)'}
              </Typography>
              {comparison.vsExcluded.available && (
                <Stack direction="row" spacing={0.5}>
                  <MatchBadge
                    label="일치"
                    count={comparison.vsExcluded.userMatch.length}
                    of={picked.length}
                    color="error"
                  />
                </Stack>
              )}
            </Stack>
            {comparison.vsExcluded.warning && (
              <Typography variant="caption" color="error.light" sx={{ mt: 0.5, display: 'block' }}>
                ⚠ 배제 후보와 2개 이상 겹침 — 누적 분석상 약한 신호일 수 있습니다.
              </Typography>
            )}
          </Paper>
        </>
      )}

      {/* ─── 대량 비교 결과 ─────────────────────────────────────── */}
      {activeComparison && (
        <>
          <Divider sx={{ my: 2 }} />
          {!compareWinning && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              <strong>이번회차 모드</strong> — 당첨번호·적중률 비교는 표시하지 않습니다.
              줄간 겹침·강한 후보만 분석합니다. 당첨 검증은 <strong>복기 탭</strong>을 사용하세요.
              {roundDrawn && currentRound != null && (
                <> ({currentRound}회 추첨 완료 — 복기 탭에서 {latestRound ?? currentRound - 1}회 당첨번호와 비교)</>
              )}
            </Alert>
          )}

          {hasLineMatchingInputs && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'secondary.main' }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                justifyContent="space-between"
                spacing={1}
                sx={{ mb: 0.5 }}
              >
                <Typography variant="body2" fontWeight={700}>
                  🔀 자동 ↔ 반자동 줄 1:1 전수비교 요약
                </Typography>
                {canRenderLineMatching && (
                  <Button
                    type="button"
                    size="small"
                    variant="outlined"
                    onClick={() => lineMatchingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  >
                    상세 보기
                  </Button>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {intentSectionLabel} 탭 기준으로 자동 누적 줄과 반자동 누적 줄을 전수 비교해 공통 번호 2개 이상인 매치를 찾습니다.
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                <Chip size="small" variant="outlined" label={`자동 ${groupLineMatching.autoLineCount}줄`} />
                <Chip size="small" variant="outlined" label={`반자동 ${groupLineMatching.semiLineCount}줄`} />
                {canRenderLineMatching && (
                  <>
                    <Chip size="small" color="secondary" variant="outlined" label={`원본 페어 ${groupLineMatching.rawPairCount}건`} />
                    <Chip size="small" color="secondary" label={`통합 카드 ${groupLineMatching.groupCount}건`} sx={{ fontWeight: 700 }} />
                    <Chip size="small" variant="outlined" label={`현재 표시 ${visibleGroupMatchTotal}건`} />
                  </>
                )}
              </Stack>
              {!canRenderLineMatching && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  자동과 반자동 누적 줄이 모두 있어야 1:1 전수비교가 표시됩니다.
                </Alert>
              )}
            </Paper>
          )}

          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }} flexWrap="wrap" gap={1}>
            <Typography variant="subtitle1" fontWeight={700}>
              📋 대량 비교 결과 ({activeComparison.ticketCount}장)
            </Typography>
          </Stack>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'stretch', sm: 'center' }}
            spacing={1}
            sx={{ mb: 1.5, position: 'relative', zIndex: 1 }}
            useFlexGap
          >
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              <Button
                type="button"
                size="small"
                variant="outlined"
                disabled={isReanalyzing}
                onClick={() => void handleReanalyze()}
                sx={{ minWidth: 88 }}
              >
                {isReanalyzing ? (
                  <><CircularProgress size={14} sx={{ mr: 0.5 }} />재분석…</>
                ) : (
                  '↻ 재분석'
                )}
              </Button>
              <Button type="button" size="small" color="error" variant="outlined" onClick={resetBulk}>
                초기화
              </Button>
            </Stack>
            {compareWinning ? (
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                <TextField
                  size="small"
                  label="비교 회차"
                  type="number"
                  value={effectiveRound ?? ''}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isInteger(v) && v > 0 && (!latestRound || v <= latestRound)) {
                      setCompareRound(v);
                    } else if (e.target.value === '') {
                      setCompareRound(null);
                    }
                  }}
                  inputProps={{ min: 1, max: latestRound ?? undefined, step: 1 }}
                  sx={{ width: 130 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                  {compareRound != null
                    ? '복기 기준'
                    : latest.data
                      ? `최신 ${latest.data.round}회`
                      : ''}
                </Typography>
                {compareRound != null && (
                  <Button type="button" size="small" onClick={() => setCompareRound(null)}>
                    ↺ 최신
                  </Button>
                )}
              </Stack>
            ) : (
              <Chip
                size="small"
                color="secondary"
                label={`이번회차 ${effectiveRound ?? '?'}회 (당첨번호 미사용)`}
              />
            )}
          </Stack>

          {/* 집계 메트릭 — 복기 탭에서만 당첨 적중률 */}
          {compareWinning && (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                color="primary"
                label={`평균 적중 ${activeComparison.avgHits.toFixed(3)} / 6`}
                sx={{ fontWeight: 700 }}
              />
              <Chip size="small" label={`고유 번호 ${activeComparison.uniqueNumberCount}/45`} variant="outlined" />
              <Chip
                size="small"
                color="success"
                label={`3등이상 ${(activeComparison.hitRates.threePlus * 100).toFixed(2)}%`}
                sx={{ fontWeight: 700 }}
              />
              <Chip
                size="small"
                color="warning"
                label={`4등이상 ${(activeComparison.hitRates.fourPlus * 100).toFixed(2)}%`}
              />
              <Chip
                size="small"
                color="error"
                label={`1등 ${(activeComparison.hitRates.six * 100).toFixed(4)}%`}
              />
              {activeComparison.excludedWarningCount > 0 && (
                <Chip
                  size="small"
                  color="error"
                  label={`⚠ 배제 매치 2+ 티켓: ${activeComparison.excludedWarningCount}`}
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              ※ 베이스라인(균등 무작위) 평균 적중 = 0.800 — 본 결과와 비교해 보세요.
            </Typography>
          </Paper>
          )}

          {compareWinning && (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              적중 개수 분포
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {[0, 1, 2, 3, 4, 5, 6].map((hits) => {
                const count = activeComparison.hitDistribution[hits] ?? 0;
                const pct = activeComparison.ticketCount > 0
                  ? (count / activeComparison.ticketCount) * 100
                  : 0;
                return (
                  <Chip
                    key={hits}
                    size="small"
                    label={`${hits}개: ${count}장 (${pct.toFixed(1)}%)`}
                    color={hits >= 3 ? 'success' : 'default'}
                    variant={hits >= 3 ? 'filled' : 'outlined'}
                  />
                );
              })}
            </Stack>
          </Paper>
          )}

          {!compareWinning && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={`고유 번호 ${activeComparison.uniqueNumberCount}/45`} variant="outlined" />
                <Chip
                  size="small"
                  color="secondary"
                  label={`2개+ 강한후보 겹침 ${activeComparison.twoPlusStrongCount}장`}
                />
                <Chip size="small" label={`3개+ 강한후보 겹침 ${activeComparison.threePlusStrongCount}장`} />
              </Stack>
            </Paper>
          )}

          {/* 당첨번호 표시 — 복기 탭 전용 */}
          {compareWinning && comparisonRoundData?.numbers && (
            <Paper
              variant="outlined"
              sx={{
                p: 1.5,
                mb: 1.5,
                borderColor: 'warning.main',
                borderWidth: 2,
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                <Typography variant="body2" fontWeight={700}>
                  🎯 {comparisonRoundData.round}회 당첨번호
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {comparisonRoundData.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={32} />
                  ))}
                  <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center', mx: 0.5 }}>
                    + 보너스
                  </Typography>
                  <LottoBall number={comparisonRoundData.bonus} size={28} />
                </Stack>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                ※ 아래 티켓의 번호 중 당첨번호와 일치하는 것은 색상 유지, 미일치는 회색 dim 처리.
              </Typography>
            </Paper>
          )}

          {/* 전체 티켓 목록 — 자동 / 반자동 각각 § 1, § 3 추가 세팅의 평탄화 패턴과 동일 룩.
              데이터 소스: 자동 = currentSlipLines + slipQueue + bulkAutoTickets,
                          반자동 = semiCurrentLines + semiSlipQueue + bulkTickets. */}
          {(() => {
            const autoTickets = [
              ...currentSlipLines.map((line, idx) => ({
                key: `auto-current-${idx}`,
                label: `입력 중·${line.label}`,
                numbers: line.numbers,
                onRemove: onRemoveCurrentLine ? () => onRemoveCurrentLine(idx) : undefined,
              })),
              ...slipQueue.flatMap((slip, slipIdx) =>
                slip.lines.map((line, lineIdx) => ({
                  key: `auto-slip-${slipIdx}-${lineIdx}`,
                  label: `용지${slipIdx + 1}·${line.label}`,
                  numbers: line.numbers,
                  onRemove: onRemoveSlipLine ? () => onRemoveSlipLine(slipIdx, lineIdx) : undefined,
                }))
              ),
              ...bulkAutoTickets.map((ticket, idx) => ({
                key: `auto-bulk-${idx}`,
                label: `대량 #${idx + 1}`,
                numbers: ticket,
                onRemove: onRemoveBulkAutoTicket ? () => onRemoveBulkAutoTicket(idx) : undefined,
              })),
            ];
            const semiTickets = [
              ...semiCurrentLines.map((line, idx) => ({
                key: `semi-current-${idx}`,
                label: `입력 중·${line.label}`,
                numbers: line.numbers,
                onRemove: () => removeCurrentLine(idx),
              })),
              ...semiSlipQueue.flatMap((slip, slipIdx) =>
                slip.lines.map((line, lineIdx) => ({
                  key: `semi-slip-${slipIdx}-${lineIdx}`,
                  label: `용지${slipIdx + 1}·${line.label}`,
                  numbers: line.numbers,
                  onRemove: () => removeSlipLine(slipIdx, lineIdx),
                }))
              ),
              ...bulkTickets.map((ticket, idx) => ({
                key: `semi-bulk-${idx}`,
                label: `대량 #${idx + 1}`,
                numbers: ticket,
                onRemove: () =>
                  setBulkTickets((prev) => prev.filter((_, i) => i !== idx)),
              })),
            ];
            const renderRow = (
              t: { key: string; label: string; numbers: number[]; onRemove?: () => void },
              idx: number
            ) => {
              const matchCount = winningSet
                ? t.numbers.filter((n) => winningSet.has(n)).length
                : 0;
              return (
                <Stack
                  key={t.key}
                  direction="row"
                  alignItems="center"
                  spacing={0.5}
                  flexWrap="wrap"
                  useFlexGap
                >
                  <Typography variant="caption" sx={{ minWidth: 36, color: 'text.secondary', fontWeight: 600 }}>
                    #{idx + 1}
                  </Typography>
                  <Chip size="small" label={t.label} variant="outlined" sx={{ minWidth: 84 }} />
                  <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                    {t.numbers.map((n) => (
                      <LottoBall
                        key={`${t.key}-${n}`}
                        number={n}
                        size={22}
                        dimmed={winningSet ? !winningSet.has(n) : false}
                      />
                    ))}
                  </Stack>
                  {winningSet && (
                    <Chip
                      size="small"
                      color={matchCount >= 3 ? 'success' : 'default'}
                      label={`${matchCount}/6`}
                      sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                    />
                  )}
                  {t.onRemove && (
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        t.onRemove!();
                      }}
                      aria-label="삭제"
                      sx={{ ml: 'auto' }}
                    >
                      ×
                    </IconButton>
                  )}
                </Stack>
              );
            };
            return (
              <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setShowAllTickets((v) => !v)}
                >
                  <Typography variant="body2" fontWeight={700}>
                    🎫 전체 티켓 목록 — 자동 {autoTickets.length}줄 / 반자동 {semiTickets.length}줄
                    {showAllTickets ? ' ▼' : ' ▶'}
                  </Typography>
                  <Button size="small" variant="text">
                    {showAllTickets ? '접기' : '펼치기'}
                  </Button>
                </Stack>
                {showAllTickets && (
                  <Box sx={{ mt: 1 }}>
                    {/* 자동 영역 — § 1 추가 세팅과 동일 데이터 소스·카운트 형식 */}
                    <Typography variant="caption" color="success.light" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                      📋 자동 누적: {slipQueue.length}장 · 입력 중 {currentSlipLines.length}/{GAME_LABELS.length}줄 · 대량 {bulkAutoTickets.length}장 · 총 {autoTickets.length}줄
                    </Typography>
                    {autoTickets.length === 0 ? (
                      <Alert severity="info" sx={{ mb: 1.5 }}>
                        자동 데이터가 없습니다. 상단 § 1 의 '구입번호 직접입력' 으로 추가하세요.
                      </Alert>
                    ) : (
                      <Box sx={{ maxHeight: 280, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75, mb: 1.5 }}>
                        <Stack spacing={0.5}>{autoTickets.map(renderRow)}</Stack>
                      </Box>
                    )}

                    {/* 반자동 영역 — § 3 추가 세팅과 동일 데이터 소스·카운트 형식 */}
                    <Typography variant="caption" color="primary.light" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                      🔄 반자동 누적: {semiSlipQueue.length}장 · 입력 중 {semiCurrentLines.length}/{GAME_LABELS.length}줄 · 대량 {bulkTickets.length}장 · 총 {semiTickets.length}줄
                    </Typography>
                    {semiTickets.length === 0 ? (
                      <Alert severity="info">
                        반자동 데이터가 없습니다. 그리드에서 6개 선택 후 [줄 저장] 하거나 [⬆ 대량 입력] 으로 추가하세요.
                      </Alert>
                    ) : (
                      <Box sx={{ maxHeight: 280, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75 }}>
                        <Stack spacing={0.5}>{semiTickets.map(renderRow)}</Stack>
                      </Box>
                    )}
                  </Box>
                )}
              </Paper>
            );
          })()}

          {/* 추천 조합 — 복기 탭 통계 종합 스코어링 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="body2" fontWeight={700}>
                🎲 {compareWinning ? '복기 통계 종합' : '반자동+자동 누적'} 추천 조합
              </Typography>
              <Button
                type="button"
                size="small"
                variant="contained"
                color="success"
                onClick={generateRecommendations}
                disabled={
                  combinedTickets.length === 0 &&
                  !accumulated &&
                  resolvedStrongCandidates.length === 0
                }
              >
                추천 5세트 생성
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {compareWinning ? (
                <>
                  <strong>자동∩반자동 교집합</strong>과 <strong>자동↔반자동 1:1 줄 매칭(공통 번호)</strong>을
                  핵심 축으로, 강한 후보·콤보 패턴을 더해 6번호 5세트를 생성합니다.
                  당첨 일치 개수는 점수에 넣지 않고 결과 카드에 표시만 합니다(예측 정합성 평가용).
                </>
              ) : (
                <>
                  반자동/자동 빈도 + 강한 후보 + 줄간 겹침 신호를 종합해 6번호 5세트를 생성합니다.
                </>
              )}
              {combinedTickets.length === 0
                ? (resolvedStrongCandidates.length > 0
                    ? ` ※ 입력 줄이 없어 복기 통계 신호(강한 후보 ${resolvedStrongCandidates.length}개)만으로 생성합니다.`
                    : ' ※ 자동·반자동 번호를 입력하거나 [재분석]으로 통계 신호를 먼저 불러오세요.')
                : ` 분석 대상 ${combinedTickets.length}줄.`}
              {' '}정직성: 수학적 당첨 확률(1/8,145,060)은 동일하며, 통계적으로 1등에 거의 없는
              조합(합 극단·전부 홀짝·4연속 등)을 제외하고 복기 신호와의 정합성을 높입니다.
            </Typography>
            {recommendations.length > 0 && (
              <Stack spacing={0.75}>
                {recommendations.map((rec, idx) => (
                  <Stack
                    key={`rec-${idx}`}
                    direction="row"
                    alignItems="center"
                    spacing={0.5}
                    flexWrap="wrap"
                    useFlexGap
                  >
                    <Chip size="small" label={`${idx + 1}`} variant="outlined" sx={{ minWidth: 32, fontWeight: 700 }} />
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {rec.combo.map((n) => (
                        <LottoBall key={n} number={n} size={28} dimmed={winningSet ? !winningSet.has(n) : false} />
                      ))}
                    </Stack>
                    {compareWinning && winningSet && (
                      <Chip
                        size="small"
                        color={rec.winMatch >= 3 ? 'success' : rec.winMatch >= 2 ? 'warning' : 'default'}
                        label={`당첨 ${rec.winMatch}/6`}
                        sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                      />
                    )}
                    {rec.strongMatch >= 2 && (
                      <Chip
                        size="small"
                        color={rec.strongMatch >= 3 ? 'success' : 'warning'}
                        variant="outlined"
                        label={`강한후보 ${rec.strongMatch}`}
                        sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                      />
                    )}
                    {rec.signals.length > 0 && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={rec.signals.slice(0, 4).join(' · ')}
                        sx={{ height: 18, fontSize: 10 }}
                      />
                    )}
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                      점수 {rec.totalScore.toFixed(0)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </Paper>

          {/* 신호 매치 상위 — 당첨번호 없이 강한후보·콤보 패턴 기준 */}
          {activeComparison.bestSignalTickets.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                🏆 {intentSectionLabel} 신호 매치 상위 5장
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                추첨기·후속출현·클래식·용지 4신호 통합 강한후보 + 누적 페어/트리플 콤보 일치 점수 —{' '}
                <strong>당첨번호 사후 비교와 무관</strong>한 예측 신호입니다.
              </Typography>
              <Stack spacing={1}>
                {activeComparison.bestSignalTickets.map((t) => (
                  <Stack
                    key={`signal-${t.index}`}
                    direction="row"
                    alignItems="center"
                    spacing={0.75}
                    sx={{ flexWrap: 'wrap' }}
                    useFlexGap
                  >
                    <Chip
                      size="small"
                      label={`#${t.index + 1}`}
                      variant="outlined"
                      sx={{ minWidth: 48 }}
                    />
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {t.ticket.map((n) => (
                        <LottoBall
                          key={n}
                          number={n}
                          size={24}
                          dimmed={
                            winningSet && compareWinning ? !winningSet.has(n) : false
                          }
                        />
                      ))}
                    </Stack>
                    <Chip
                      size="small"
                      color={t.vsStrongMatch.length >= 3 ? 'success' : t.vsStrongMatch.length >= 2 ? 'warning' : 'default'}
                      label={`강한후보 ${t.vsStrongMatch.length}`}
                      sx={{ fontWeight: 700 }}
                    />
                    {(t.matchedPairCount > 0 || t.matchedTripleCount > 0) && (
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={`콤보 P${t.matchedPairCount} T${t.matchedTripleCount}`}
                        sx={{ fontWeight: 700 }}
                      />
                    )}
                    <Typography variant="caption" color="text.secondary">
                      신호점수 {ticketSignalScore(t).toFixed(0)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}

          {/* 복기 사후 검증 — 당첨번호 일치 상위 (접기, 기본 숨김) */}
          {compareWinning &&
            winningNumbers.length > 0 &&
            activeComparison.bestTickets.some((t) => t.vsLatestMatch.length > 0) && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'divider', opacity: 0.92 }}>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ mb: showBacktestTop ? 1 : 0 }}
              >
                <Box>
                  <Typography variant="body2" fontWeight={700}>
                    📋 {effectiveRound ?? '?'}회 복기 검증 — 당첨 일치 상위 (사후 확인)
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    이미 추첨된 {effectiveRound ?? '?'}회 당첨번호와 비교 — 다음 회차 예측에는 의미 없음
                  </Typography>
                </Box>
                <Button
                  type="button"
                  size="small"
                  variant="text"
                  onClick={() => setShowBacktestTop((v) => !v)}
                >
                  {showBacktestTop ? '접기' : '펼치기'}
                </Button>
              </Stack>
              {showBacktestTop && (
                <Stack spacing={1}>
                  {activeComparison.bestTickets
                    .filter((t) => t.vsLatestMatch.length > 0)
                    .map((t) => (
                      <Stack
                        key={t.index}
                        direction="row"
                        alignItems="center"
                        spacing={0.75}
                        sx={{ flexWrap: 'wrap' }}
                        useFlexGap
                      >
                        <Chip
                          size="small"
                          label={`#${t.index + 1}`}
                          variant="outlined"
                          sx={{ minWidth: 48 }}
                        />
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {t.ticket.map((n) => (
                            <LottoBall
                              key={n}
                              number={n}
                              size={24}
                              dimmed={winningSet ? !winningSet.has(n) : false}
                            />
                          ))}
                        </Stack>
                        <Chip
                          size="small"
                          color={t.vsLatestMatch.length >= 3 ? 'success' : 'default'}
                          label={`당첨 ${t.vsLatestMatch.length}/6${t.bonusMatch ? ' +🎁' : ''}`}
                          sx={{ fontWeight: 700 }}
                        />
                        <Typography variant="caption" color="text.secondary">
                          ({t.vsLatestMatch.join(', ')})
                        </Typography>
                      </Stack>
                    ))}
                </Stack>
              )}
            </Paper>
          )}

          {/* ── 누적 자동 강한 후보 교집합 분포 — 자동+반자동 통합 통계 ── */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'primary.main' }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              🔗 {intentSectionLabel} 자동 누적 강한 후보 교집합 (자동+반자동 {intersectionCmp.ticketCount}장 통합 분석)
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              ※ <strong>분석 모집단 = 강한 후보 {resolvedStrongCandidates.length}개 안의 부분 조합만</strong>.
              각 티켓의 번호 중 강한 후보에 속한 것 (vsStrongMatch) 이 2개 이상일 때만 그 교집합 세트를 그룹화.
              아래 별도 패널인 '🔀 자동 ∩ 반자동' 은 <strong>1~45 전체 모집단</strong>을 보는 다른 분석 — 모집단이 달라 카운트도 다름.
            </Typography>
            {resolvedStrongCandidates.length > 0 ? (
              <>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                  {[0, 1, 2, 3, 4, 5, 6].map((k) => {
                    const count = intersectionCmp.strongIntersectionDistribution[k] ?? 0;
                    const pct = intersectionCmp.ticketCount > 0
                      ? (count / intersectionCmp.ticketCount) * 100
                      : 0;
                    return (
                      <Chip
                        key={k}
                        size="small"
                        label={`${k}개: ${count}장 (${pct.toFixed(1)}%)`}
                        color={k >= 3 ? 'success' : k >= 2 ? 'warning' : 'default'}
                        variant={k >= 2 ? 'filled' : 'outlined'}
                      />
                    );
                  })}
                </Stack>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                  <Chip
                    size="small"
                    color="warning"
                    label={`🟡 강한 후보와 2개 이상 겹친 티켓: ${intersectionCmp.twoPlusStrongCount}장 (${intersectionCmp.ticketCount > 0 ? (intersectionCmp.twoPlusStrongCount / intersectionCmp.ticketCount * 100).toFixed(2) : '0.00'}%)`}
                    sx={{ fontWeight: 700 }}
                  />
                  <Chip
                    size="small"
                    color="success"
                    label={`🟢 강한 후보와 3개 이상 겹친 티켓: ${intersectionCmp.threePlusStrongCount}장 (${intersectionCmp.ticketCount > 0 ? (intersectionCmp.threePlusStrongCount / intersectionCmp.ticketCount * 100).toFixed(2) : '0.00'}%)`}
                    sx={{ fontWeight: 700 }}
                  />
                </Stack>
              </>
            ) : (
              <Alert severity="info" sx={{ py: 0.5 }}>
                {intentSectionLabel} 강한 후보가 아직 없습니다. 자동 용지를 [분석·저장]하거나 줄을 더 등록하면
                교집합 분포가 표시됩니다. (강한 후보가 없으면 교집합 통계는 의미가 없어 숨깁니다.)
              </Alert>
            )}
            {strongCandidateSource === 'none' && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                ※ {intentSectionLabel} 자동 누적 데이터가 없습니다. 자동 용지를 분석하여 누적을 만들면 교집합 분석이 활성화됩니다.
              </Typography>
            )}
            {strongCandidateSource === 'local' && (
              <Typography variant="caption" color="warning.main" sx={{ mt: 0.5, display: 'block' }}>
                ※ 서버 누적 없음 — 등록한 자동 줄 {autoOnlyLines.length}개에서 강한 후보 {resolvedStrongCandidates.length}개를 추정했습니다. [분석·저장] 또는 재분석으로 통합 신호를 불러오세요.
              </Typography>
            )}
            {strongCandidateSource === 'unified-rules' && predictionSignals && (
              <Typography variant="caption" color="success.main" sx={{ mt: 0.5, display: 'block' }}>
                ※ 규칙 v{predictionSignals.rules_version} — 추첨기·후속출현·클래식·용지·평행회차 5신호 통합 강한 후보 {resolvedStrongCandidates.length}개 (대상 {predictionSignals.target_round}회)
              </Typography>
            )}

            {/* 교집합 세트별 빈도 — 어느 번호가 정확히 겹친 케이스 (전체 노출) */}
            {(intersectionCmp.twoIntersectionGroups.length > 0 ||
              intersectionCmp.threeIntersectionGroups.length > 0 ||
              intersectionCmp.fourPlusIntersectionGroups.length > 0) && (
              <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
                {/* 헤더 + 집계 메트릭 */}
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                  useFlexGap
                  spacing={0.5}
                  sx={{ mb: 1 }}
                >
                  <Typography variant="caption" sx={{ fontWeight: 700 }}>
                    📌 강한 후보({resolvedStrongCandidates.length}개) 중 어떤 쌍이 티켓에 자주 함께 나왔는지 — 강한 후보의 부분 조합만
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    <Chip
                      size="small"
                      label={`총 ${
                        intersectionCmp.twoIntersectionGroups.length +
                        intersectionCmp.threeIntersectionGroups.length +
                        intersectionCmp.fourPlusIntersectionGroups.length
                      }종`}
                      variant="outlined"
                      sx={{ fontWeight: 700 }}
                    />
                    {intersectionCmp.twoIntersectionGroups.length > 0 && (
                      <Chip
                        size="small"
                        color="warning"
                        label={`2번호 일치: ${intersectionCmp.twoIntersectionGroups.length}종`}
                        variant="outlined"
                      />
                    )}
                    {intersectionCmp.threeIntersectionGroups.length > 0 && (
                      <Chip
                        size="small"
                        color="success"
                        label={`3번호 일치: ${intersectionCmp.threeIntersectionGroups.length}종`}
                        variant="outlined"
                      />
                    )}
                    {intersectionCmp.fourPlusIntersectionGroups.length > 0 && (
                      <Chip
                        size="small"
                        color="error"
                        label={`4번호 이상 일치: ${intersectionCmp.fourPlusIntersectionGroups.length}종`}
                        variant="outlined"
                      />
                    )}
                  </Stack>
                </Stack>

                {/* 2개 교집합 — 전체 노출 (스크롤 컨테이너) */}
                {intersectionCmp.twoIntersectionGroups.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography
                      variant="caption"
                      color="warning.light"
                      sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                    >
                      🟡 강한 후보 안에서 2개씩 겹친 세트 — 전체 {intersectionCmp.twoIntersectionGroups.length}종 (상한 = C(강한후보 개수, 2))
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 320,
                        overflowY: 'auto',
                        pr: 0.5,
                        py: 0.5,
                        bgcolor: 'action.hover',
                        borderRadius: 1,
                      }}
                    >
                      <Stack spacing={0.5} sx={{ px: 1 }}>
                        {intersectionCmp.twoIntersectionGroups.map((g, idx) => {
                          const pct = intersectionCmp.ticketCount > 0
                            ? (g.ticketCount / intersectionCmp.ticketCount) * 100
                            : 0;
                          return (
                            <Stack
                              key={`int2-${g.numbers.join('-')}`}
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                              flexWrap="wrap"
                              useFlexGap
                            >
                              <Typography
                                variant="caption"
                                sx={{ width: 28, color: 'text.secondary', fontWeight: 600 }}
                              >
                                #{idx + 1}
                              </Typography>
                              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                                {g.numbers.map((n) => (
                                  <LottoBall
                                    key={n}
                                    number={n}
                                    size={26}
                                    dimmed={winningSet ? !winningSet.has(n) : false}
                                  />
                                ))}
                              </Stack>
                              <Chip
                                size="small"
                                label={`${g.ticketCount}장 (${pct.toFixed(2)}%)`}
                                color="warning"
                                variant="filled"
                                sx={{ fontWeight: 700 }}
                              />
                            </Stack>
                          );
                        })}
                      </Stack>
                    </Box>
                  </Box>
                )}

                {/* 3개 교집합 — 전체 노출 (스크롤 컨테이너) */}
                {intersectionCmp.threeIntersectionGroups.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography
                      variant="caption"
                      color="success.light"
                      sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                    >
                      🟢 강한 후보 안에서 3개씩 겹친 세트 — 전체 {intersectionCmp.threeIntersectionGroups.length}종 (상한 = C(강한후보 개수, 3))
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 320,
                        overflowY: 'auto',
                        pr: 0.5,
                        py: 0.5,
                        bgcolor: 'action.hover',
                        borderRadius: 1,
                      }}
                    >
                      <Stack spacing={0.5} sx={{ px: 1 }}>
                        {intersectionCmp.threeIntersectionGroups.map((g, idx) => {
                          const pct = intersectionCmp.ticketCount > 0
                            ? (g.ticketCount / intersectionCmp.ticketCount) * 100
                            : 0;
                          return (
                            <Stack
                              key={`int3-${g.numbers.join('-')}`}
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                              flexWrap="wrap"
                              useFlexGap
                            >
                              <Typography
                                variant="caption"
                                sx={{ width: 28, color: 'text.secondary', fontWeight: 600 }}
                              >
                                #{idx + 1}
                              </Typography>
                              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                                {g.numbers.map((n) => (
                                  <LottoBall
                                    key={n}
                                    number={n}
                                    size={26}
                                    dimmed={winningSet ? !winningSet.has(n) : false}
                                  />
                                ))}
                              </Stack>
                              <Chip
                                size="small"
                                label={`${g.ticketCount}장 (${pct.toFixed(2)}%)`}
                                color="success"
                                variant="filled"
                                sx={{ fontWeight: 700 }}
                              />
                            </Stack>
                          );
                        })}
                      </Stack>
                    </Box>
                  </Box>
                )}

                {/* 4개+ 교집합 — 전체 노출 */}
                {intersectionCmp.fourPlusIntersectionGroups.length > 0 && (
                  <Box>
                    <Typography
                      variant="caption"
                      color="error.light"
                      sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                    >
                      🔴 강한 후보 안에서 4개 이상 겹친 세트 — 전체 {intersectionCmp.fourPlusIntersectionGroups.length}종 (강한 후보 부분 조합, 희귀)
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 320,
                        overflowY: 'auto',
                        pr: 0.5,
                        py: 0.5,
                        bgcolor: 'action.hover',
                        borderRadius: 1,
                      }}
                    >
                      <Stack spacing={0.5} sx={{ px: 1 }}>
                        {intersectionCmp.fourPlusIntersectionGroups.map((g, idx) => {
                          const pct = intersectionCmp.ticketCount > 0
                            ? (g.ticketCount / intersectionCmp.ticketCount) * 100
                            : 0;
                          return (
                            <Stack
                              key={`int4-${g.numbers.join('-')}`}
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                              flexWrap="wrap"
                              useFlexGap
                            >
                              <Typography
                                variant="caption"
                                sx={{ width: 28, color: 'text.secondary', fontWeight: 600 }}
                              >
                                #{idx + 1}
                              </Typography>
                              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                                {g.numbers.map((n) => (
                                  <LottoBall
                                    key={n}
                                    number={n}
                                    size={26}
                                    dimmed={winningSet ? !winningSet.has(n) : false}
                                  />
                                ))}
                              </Stack>
                              <Chip
                                size="small"
                                label={`${g.size}개 · ${g.ticketCount}장 (${pct.toFixed(2)}%)`}
                                color="error"
                                variant="filled"
                                sx={{ fontWeight: 700 }}
                              />
                            </Stack>
                          );
                        })}
                      </Stack>
                    </Box>
                  </Box>
                )}
              </Box>
            )}
          </Paper>
        </>
      )}

      {/* ── 자동 ↔ 반자동 줄 페어 1:1 매칭 — picked 와 무관, 누적 데이터만 있으면 표시 ── */}
      {canRenderLineMatching && (
            <Box ref={lineMatchingRef}>
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'secondary.main' }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                🔀 자동 ↔ 반자동 줄 1:1 매칭 (공통 번호 2~6개)
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                자동 {groupLineMatching.autoLineCount}줄
                {groupLineMatching.autoDupRemoved > 0 && (
                  <> (중복 <strong>{groupLineMatching.autoDupRemoved}건</strong> 제외)</>
                )}
                {' × '}반자동 {groupLineMatching.semiLineCount}줄
                {groupLineMatching.semiDupRemoved > 0 && (
                  <> (중복 <strong>{groupLineMatching.semiDupRemoved}건</strong> 제외)</>
                )}
                {' = '}전수 비교 {groupLineMatching.totalPairCount}개 페어 가운데 공통 번호 ≥2 인
                페어 {groupLineMatching.rawPairCount}건. <strong>같은 매치 번호를 가진 자동/반자동 줄들</strong>은
                한 카드로 통합 (자동 list + 반자동 list) → 화면 카드 {groupLineMatching.groupCount}건. 일치 개수
                (6 → 5 → 4 → 3 → 2) 순으로 모두 노출.
              </Typography>
              {groupLineMatching.strongAvailable && (
                <Box sx={{ mb: 1, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.3 }}>
                    🎯 {intentSectionLabel} 자동 누적 강한 후보 ({groupLineMatching.strongCandidateCount}개) 기반 통계 — 그룹별 매치 번호와의 일치 분포
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {[0, 1, 2, 3, 4, 5, 6].map((k) => {
                      const cnt = groupLineMatching.strongDist[k] ?? 0;
                      if (cnt === 0 && k > 0) return null;
                      const pct =
                        groupLineMatching.groupCount > 0
                          ? (cnt / groupLineMatching.groupCount) * 100
                          : 0;
                      return (
                        <Chip
                          key={k}
                          size="small"
                          color={k >= 3 ? 'success' : k >= 2 ? 'warning' : 'default'}
                          variant={k >= 2 ? 'filled' : 'outlined'}
                          label={`강한 후보 ${k}개 일치: ${cnt}건 (${pct.toFixed(1)}%)`}
                          sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                        />
                      );
                    })}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.3 }}>
                    ※ 정렬은 {winningSet ? '당첨번호 일치 → ' : ''}강한 후보 일치 개수 내림차순. 위쪽 카드일수록 강한 후보가 많이 겹친 매치.
                  </Typography>
                </Box>
              )}
              {(groupLineMatching.autoDupRemoved > 0 || groupLineMatching.semiDupRemoved > 0) && (
                <Alert severity="info" sx={{ mb: 1, fontSize: 11 }}>
                  같은 6번호 줄이 그룹 안에 2개 이상 들어가 있어 첫 번째 줄로 통합했습니다.
                  {groupLineMatching.autoDupSamples.length > 0 && (
                    <>
                      <br />
                      <strong>자동 중복 예시:</strong> {groupLineMatching.autoDupSamples.join(' · ')}
                      {groupLineMatching.autoDupRemoved > groupLineMatching.autoDupSamples.length &&
                        ` 외 ${groupLineMatching.autoDupRemoved - groupLineMatching.autoDupSamples.length}건`}
                    </>
                  )}
                  {groupLineMatching.semiDupSamples.length > 0 && (
                    <>
                      <br />
                      <strong>반자동 중복 예시:</strong> {groupLineMatching.semiDupSamples.join(' · ')}
                      {groupLineMatching.semiDupRemoved > groupLineMatching.semiDupSamples.length &&
                        ` 외 ${groupLineMatching.semiDupRemoved - groupLineMatching.semiDupSamples.length}건`}
                    </>
                  )}
                </Alert>
              )}
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'stretch', sm: 'center' }}
                sx={{ mb: 1.25 }}
              >
                <TextField
                  size="small"
                  label="매치 번호 검색"
                  value={lineMatchNumberFilter}
                  onChange={(e) => setLineMatchNumberFilter(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="예: 29"
                  sx={{ width: { xs: '100%', sm: 140 } }}
                />
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {(['all', 6, 5, 4, 3, 2] as const).map((value) => (
                    <Chip
                      key={`match-filter-${value}`}
                      size="small"
                      clickable
                      color={lineMatchFilter === value ? 'primary' : 'default'}
                      variant={lineMatchFilter === value ? 'filled' : 'outlined'}
                      label={value === 'all' ? '전체' : `${value}개 일치`}
                      onClick={() => setLineMatchFilter(value)}
                    />
                  ))}
                </Stack>
                {(lineMatchFilter !== 'all' || lineMatchNumberFilter) && (
                  <Button
                    type="button"
                    size="small"
                    color="inherit"
                    onClick={() => {
                      setLineMatchFilter('all');
                      setLineMatchNumberFilter('');
                    }}
                  >
                    초기화
                  </Button>
                )}
              </Stack>
              {(() => {
                const matchedSet = (matched: number[]): Set<number> => new Set(matched);
                const renderGroupSection = (
                  label: string,
                  color: 'warning' | 'success' | 'error' | 'primary' | 'info',
                  groups: typeof groupLineMatching.groups6
                ) => {
                  if (groups.length === 0) return null;
                  return (
                    <Box sx={{ mb: 1.5 }}>
                      <Typography
                        variant="caption"
                        color={`${color}.light`}
                        sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                      >
                        {label} — {groups.length}건
                      </Typography>
                      <Box
                        sx={{
                          maxHeight: 480,
                          overflowY: 'auto',
                          bgcolor: 'action.hover',
                          borderRadius: 1,
                          p: 0.75,
                        }}
                      >
                        <Stack spacing={0.75}>
                          {groups.map((g, idx) => {
                            const mset = matchedSet(g.matchedNumbers);
                            return (
                              <Box
                                key={g.key}
                                sx={{
                                  p: 0.5,
                                  borderRadius: 1,
                                  bgcolor: 'background.paper',
                                }}
                              >
                                <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                                  <Typography variant="caption" sx={{ minWidth: 32, color: 'text.secondary', fontWeight: 600 }}>
                                    #{idx + 1}
                                  </Typography>
                                  <Chip
                                    size="small"
                                    color={color}
                                    label={`${g.matchCount}개 일치`}
                                    sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                                  />
                                  <Chip
                                    size="small"
                                    variant="outlined"
                                    label={`매치: ${g.matchedNumbers.join(', ')}`}
                                    sx={{ height: 18, fontSize: 11 }}
                                  />
                                  <Chip
                                    size="small"
                                    color="success"
                                    variant="outlined"
                                    label={`자동 ${g.autoList.length}줄`}
                                    sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                                  />
                                  <Chip
                                    size="small"
                                    color="primary"
                                    variant="outlined"
                                    label={`반자동 ${g.semiList.length}줄`}
                                    sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                                  />
                                  {winningSet && (() => {
                                    const w = g.matchedNumbers.filter((n) => winningSet.has(n)).length;
                                    return w > 0 ? (
                                      <Chip
                                        size="small"
                                        color="warning"
                                        label={`🎯 당첨 ${w}개`}
                                        sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                                      />
                                    ) : null;
                                  })()}
                                  {groupLineMatching.strongAvailable && (() => {
                                    const sm = g.matchedNumbers.filter((n) =>
                                      resolvedStrongCandidates.includes(n)
                                    ).length;
                                    return (
                                      <Chip
                                        size="small"
                                        color={sm >= 3 ? 'success' : sm >= 2 ? 'warning' : 'default'}
                                        variant={sm >= 2 ? 'filled' : 'outlined'}
                                        label={`강한 후보 ${sm}개 일치`}
                                        sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                                      />
                                    );
                                  })()}
                                </Stack>
                                <Box sx={{ mt: 0.4, pl: 0.5 }}>
                                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, display: 'block', mb: 0.2 }}>
                                    자동 측 일치 줄 ({g.autoList.length}):
                                    {winningSet && ' — 당첨번호만 컬러, 나머지 회색'}
                                  </Typography>
                                  <Stack spacing={0.2}>
                                    {g.autoList.slice(0, GROUP_LINE_RENDER_CAP).map((a) => (
                                      <Stack
                                        key={`ga-${g.key}-${a.idx}`}
                                        direction="row"
                                        alignItems="center"
                                        spacing={0.4}
                                        flexWrap="wrap"
                                        useFlexGap
                                      >
                                        <Chip
                                          size="small"
                                          color="success"
                                          variant="outlined"
                                          label={
                                            winningSet
                                              ? `자동 #${a.idx} · ${a.label} · 당첨 ${a.numbers.filter((n) => winningSet.has(n)).length}/6`
                                              : `자동 #${a.idx} · ${a.label}`
                                          }
                                          sx={{ height: 18, fontSize: 10, fontWeight: 700 }}
                                        />
                                        {a.numbers.map((n) => (
                                          <LottoBall
                                            key={`ga-${g.key}-${a.idx}-${n}`}
                                            number={n}
                                            size={20}
                                            dimmed={winningSet ? !winningSet.has(n) : !mset.has(n)}
                                          />
                                        ))}
                                      </Stack>
                                    ))}
                                    {g.autoList.length > GROUP_LINE_RENDER_CAP && (
                                      <Typography variant="caption" color="text.secondary">
                                        …외 자동 {g.autoList.length - GROUP_LINE_RENDER_CAP}줄
                                      </Typography>
                                    )}
                                  </Stack>
                                </Box>
                                <Box sx={{ mt: 0.4, pl: 0.5 }}>
                                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, display: 'block', mb: 0.2 }}>
                                    반자동 측 일치 줄 ({g.semiList.length}):
                                    {winningSet && ' — 당첨번호만 컬러, 나머지 회색'}
                                  </Typography>
                                  <Stack spacing={0.2}>
                                    {g.semiList.slice(0, GROUP_LINE_RENDER_CAP).map((s) => (
                                      <Stack
                                        key={`gs-${g.key}-${s.idx}`}
                                        direction="row"
                                        alignItems="center"
                                        spacing={0.4}
                                        flexWrap="wrap"
                                        useFlexGap
                                      >
                                        <Chip
                                          size="small"
                                          color="primary"
                                          variant="outlined"
                                          label={
                                            winningSet
                                              ? `반자동 #${s.idx} · ${s.label} · 당첨 ${s.numbers.filter((n) => winningSet.has(n)).length}/6`
                                              : `반자동 #${s.idx} · ${s.label}`
                                          }
                                          sx={{ height: 18, fontSize: 10, fontWeight: 700 }}
                                        />
                                        {s.numbers.map((n) => (
                                          <LottoBall
                                            key={`gs-${g.key}-${s.idx}-${n}`}
                                            number={n}
                                            size={20}
                                            dimmed={winningSet ? !winningSet.has(n) : !mset.has(n)}
                                          />
                                        ))}
                                      </Stack>
                                    ))}
                                    {g.semiList.length > GROUP_LINE_RENDER_CAP && (
                                      <Typography variant="caption" color="text.secondary">
                                        …외 반자동 {g.semiList.length - GROUP_LINE_RENDER_CAP}줄
                                      </Typography>
                                    )}
                                  </Stack>
                                </Box>
                              </Box>
                            );
                          })}
                        </Stack>
                      </Box>
                    </Box>
                  );
                };
                if (groupLineMatching.groupCount === 0) {
                  return (
                    <Alert severity="info">
                      공통 번호 2개 이상인 줄 페어가 없습니다. 자동 또는 반자동 한쪽에 데이터가 부족하거나 두 그룹이 완전히 다른 번호를 사용했습니다.
                    </Alert>
                  );
                }
                return (
                  <>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`통합 카드 총 ${groupLineMatching.groupCount}건 (현재 표시 ${visibleGroupMatchTotal}건 / 원본 페어 ${groupLineMatching.rawPairCount}건)`}
                        sx={{ fontWeight: 700 }}
                      />
                      {visibleGroupMatch6.length > 0 && (
                        <Chip size="small" color="error" label={`6개 일치: ${visibleGroupMatch6.length}건`} sx={{ fontWeight: 700 }} />
                      )}
                      {visibleGroupMatch5.length > 0 && (
                        <Chip size="small" color="warning" label={`5개 일치: ${visibleGroupMatch5.length}건`} sx={{ fontWeight: 700 }} />
                      )}
                      {visibleGroupMatch4.length > 0 && (
                        <Chip size="small" color="success" label={`4개 일치: ${visibleGroupMatch4.length}건`} sx={{ fontWeight: 700 }} />
                      )}
                      {visibleGroupMatch3.length > 0 && (
                        <Chip size="small" color="primary" label={`3개 일치: ${visibleGroupMatch3.length}건`} sx={{ fontWeight: 700 }} />
                      )}
                      {visibleGroupMatch2.length > 0 && (
                        <Chip size="small" color="info" label={`2개 일치: ${visibleGroupMatch2.length}건`} sx={{ fontWeight: 700 }} />
                      )}
                    </Stack>
                    {visibleGroupMatchTotal === 0 && (
                      <Alert severity="info" sx={{ mb: 1 }}>
                        현재 필터 조건에 맞는 1:1 전수비교 카드가 없습니다.
                      </Alert>
                    )}
                    {renderGroupSection('🟣 6개 일치 (한 줄 통째 일치 — 매우 희귀)', 'error', visibleGroupMatch6)}
                    {renderGroupSection('🔴 5개 일치 (희귀)', 'warning', visibleGroupMatch5)}
                    {renderGroupSection('🟠 4개 일치', 'success', visibleGroupMatch4)}
                    {renderGroupSection('🟢 3개 일치', 'primary', visibleGroupMatch3)}
                    {renderGroupSection('🟡 2개 일치 (가장 많음)', 'info', visibleGroupMatch2)}
                  </>
                );
              })()}
            </Paper>
            </Box>
          )}

      {picked.length === 6 && activeComparison && (
        <>
          {/* ── 누적 자동 페어/트리플 콤보 교집합 ──────────────── */}
          {activeComparison.comboDataAvailable && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                🔗 자동 누적 페어/트리플 콤보 교집합
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                <Chip
                  size="small"
                  color="primary"
                  label={`평균 페어 매치 ${activeComparison.avgPairMatches.toFixed(2)} / 티켓`}
                  sx={{ fontWeight: 700 }}
                />
                <Chip
                  size="small"
                  color="primary"
                  label={`평균 트리플 매치 ${activeComparison.avgTripleMatches.toFixed(3)} / 티켓`}
                  variant="outlined"
                />
              </Stack>
              <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontWeight: 600 }}>
                페어 매치 분포 (티켓 안에 자동 누적의 자주-페어가 통째로 들어 있는지):
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                {Object.entries(activeComparison.pairMatchDistribution)
                  .map(([k, v]) => [Number(k), v] as [number, number])
                  .sort((a, b) => a[0] - b[0])
                  .map(([k, v]) => {
                    const pct = activeComparison.ticketCount > 0
                      ? (v / activeComparison.ticketCount) * 100
                      : 0;
                    return (
                      <Chip
                        key={`pair-${k}`}
                        size="small"
                        label={`${k}개 페어: ${v}장 (${pct.toFixed(1)}%)`}
                        color={k >= 2 ? 'success' : k >= 1 ? 'primary' : 'default'}
                        variant={k >= 1 ? 'filled' : 'outlined'}
                      />
                    );
                  })}
              </Stack>
              <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontWeight: 600 }}>
                트리플 매치 분포:
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {Object.entries(activeComparison.tripleMatchDistribution)
                  .map(([k, v]) => [Number(k), v] as [number, number])
                  .sort((a, b) => a[0] - b[0])
                  .map(([k, v]) => {
                    const pct = activeComparison.ticketCount > 0
                      ? (v / activeComparison.ticketCount) * 100
                      : 0;
                    return (
                      <Chip
                        key={`triple-${k}`}
                        size="small"
                        label={`${k}개 트리플: ${v}장 (${pct.toFixed(1)}%)`}
                        color={k >= 1 ? 'success' : 'default'}
                        variant={k >= 1 ? 'filled' : 'outlined'}
                      />
                    );
                  })}
              </Stack>
            </Paper>
          )}

          {/* ── 콤보 점수 상위 5장 ─────────────────────────────── */}
          {activeComparison.bestComboTickets.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 1 }}>
                🥇 누적 자동과 가장 잘 맞은 티켓 5장 (페어 1점 · 트리플 3점 · 쿼드 6점)
              </Typography>
              <Stack spacing={0.75}>
                {activeComparison.bestComboTickets.map((t) => (
                  <Stack
                    key={`combo-best-${t.index}`}
                    direction="row"
                    alignItems="center"
                    spacing={0.75}
                    flexWrap="wrap"
                    useFlexGap
                  >
                    <Chip
                      size="small"
                      label={`#${t.index + 1}`}
                      variant="outlined"
                      sx={{ minWidth: 48 }}
                    />
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {t.ticket.map((n) => (
                        <LottoBall
                          key={n}
                          number={n}
                          size={22}
                          dimmed={winningSet ? !winningSet.has(n) : false}
                        />
                      ))}
                    </Stack>
                    <Chip
                      size="small"
                      color="success"
                      label={`점수 ${t.comboScore}`}
                      sx={{ fontWeight: 700 }}
                    />
                    {t.matchedPairCount > 0 && (
                      <Chip size="small" label={`페어 ${t.matchedPairCount}`} variant="outlined" />
                    )}
                    {t.matchedTripleCount > 0 && (
                      <Chip
                        size="small"
                        label={`트리플 ${t.matchedTripleCount}`}
                        color="warning"
                      />
                    )}
                    {t.vsStrongMatch.length >= 2 && (
                      <Chip
                        size="small"
                        label={`강한후보 ${t.vsStrongMatch.length}`}
                        color="primary"
                      />
                    )}
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}

          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block' }}>
            ※ 위 매치율은 과거 회차에 대한 측정값이며, 다음 회차의 당첨 확률(1/8,145,060)을 변경하지 않습니다.
            누적 자동과의 콤보 교집합은 사용자의 픽이 군중의 강한 패턴에 얼마나 정렬되는지 보여주는 관찰 도구입니다.
          </Typography>
        </>
      )}

      <Divider sx={{ my: 2 }} />
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'info.main' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
          <Typography variant="body2" fontWeight={700}>
            📡 통합 예측 신호 (규칙 v{predictionSignals?.rules_version ?? '…'})
          </Typography>
          {predictionSignalsQuery.isFetching && <CircularProgress size={16} />}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          추첨기 + 후속출현 + 클래식 + 용지({intentSectionLabel}) + 평행회차 — 가중 합산으로 강한 후보 산출.
          대상 회차: <strong>{predictionSignals?.target_round ?? effectiveRound ?? '?'}</strong>회
          {predictionSignals?.machine_id ? ` · ${predictionSignals.machine_id}호기` : ''}.
        </Typography>
        {predictionSignals ? (
          <>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              <Chip
                size="small"
                color={predictionSignals.sources.machine.available ? 'success' : 'default'}
                label={`추첨기 ${predictionSignals.sources.machine.available ? '✓' : '—'}`}
                variant="outlined"
              />
              <Chip
                size="small"
                color={predictionSignals.sources.post_occurrence.available ? 'success' : 'default'}
                label={`후속출현 ${predictionSignals.sources.post_occurrence.available ? '✓' : '—'}`}
                variant="outlined"
              />
              <Chip
                size="small"
                color={predictionSignals.sources.classic.available ? 'success' : 'default'}
                label={`클래식 ${predictionSignals.sources.classic.available ? '✓' : '—'}`}
                variant="outlined"
              />
              <Chip
                size="small"
                color={predictionSignals.sources.photo_sheet.available ? 'success' : 'default'}
                label={`용지 ${predictionSignals.sources.photo_sheet.available ? `✓ ${predictionSignals.sources.photo_sheet.total_analyses ?? 0}건` : '—'}`}
                variant="outlined"
              />
              <Chip
                size="small"
                color={predictionSignals.sources.parallel_round?.available ? 'success' : 'default'}
                label={
                  predictionSignals.sources.parallel_round?.available
                    ? `평행 ${predictionSignals.sources.parallel_round.suffix_label ?? '✓'}`
                    : '평행 —'
                }
                variant="outlined"
              />
              <Chip
                size="small"
                color={predictionSignals.sources.decade_gap?.available ? 'success' : 'default'}
                label={
                  predictionSignals.sources.decade_gap?.available
                    ? `구간미출현 ✓ ${predictionSignals.sources.decade_gap.pool_size ?? 0}수`
                    : '구간미출현 —'
                }
                variant="outlined"
              />
            </Stack>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              {(['S', 'A', 'B'] as const).map((g) => (
                <Chip
                  key={g}
                  size="small"
                  label={`${GRADE_LABELS[g].split('·')[0].trim()} ${predictionSignals.by_grade[g]?.length ?? 0}개`}
                  sx={{ bgcolor: GRADE_COLORS[g], color: '#fff', fontWeight: 700 }}
                />
              ))}
              <Chip
                size="small"
                variant="outlined"
                label={`강한후보 ${resolvedStrongCandidates.length}개`}
              />
            </Stack>
            <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
              {predictionSignals.ranked_numbers.slice(0, 12).map((r) => (
                <Chip
                  key={`sig-${r.number}`}
                  size="small"
                  label={`${r.number}·${r.grade}`}
                  sx={{
                    bgcolor: GRADE_COLORS[r.grade],
                    color: r.grade === 'C' ? 'text.primary' : '#fff',
                    fontWeight: 700,
                    height: 22,
                    fontSize: 11,
                  }}
                />
              ))}
            </Stack>
            <SignalExplanationPanel
              predictionSignals={predictionSignals}
              resolvedStrongCandidates={resolvedStrongCandidates}
              resolvedExcludedCandidates={resolvedExcludedCandidates}
              strongCandidateSource={strongCandidateSource}
            />
          </>
        ) : predictionSignalsQuery.isError ? (
          <Alert severity="warning" sx={{ py: 0.5 }}>
            통합 예측 신호를 불러오지 못했습니다. 재분석 버튼으로 다시 시도해 주세요.
          </Alert>
        ) : (
          <Alert severity="info" sx={{ py: 0.5 }}>
            통합 신호 로딩 중… 이번회차는 계산에 시간이 걸릴 수 있습니다.
          </Alert>
        )}
      </Paper>

      {(() => {
        const acc = predictionSignals?.signal_accuracy;
        if (!acc?.available) return null;
        const SRC_LABEL: Record<string, string> = {
          machine: '추첨기',
          classic: '클래식',
          parallel: '평행회차',
        };
        return (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'warning.main' }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              🎯 신호원별 적중률 (최근 {acc.rounds}회차 백테스트)
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              각 신호의 상위 {acc.top_k}개 예측이 실제 당첨 6개를 평균 몇 개 맞췄는지(walk-forward).
              무작위 기대치 <strong>{acc.random_baseline}</strong>개보다 낮으면 약한 신호 → 이번회차 가중치 보정 참고.
            </Typography>
            <Stack spacing={0.5}>
              {Object.entries(acc.by_source).map(([src, v]) => {
                if (!v.available) return null;
                const weak = src === acc.weakest_source;
                const strong = src === acc.strongest_source;
                return (
                  <Stack key={src} direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip size="small" label={SRC_LABEL[src] ?? src} variant="outlined" sx={{ minWidth: 76 }} />
                    <Typography variant="caption">
                      평균 {v.avg_hits.toFixed(2)}개 · 3개+ {v.rounds_3plus}/{v.rounds_tested}회
                    </Typography>
                    <Chip
                      size="small"
                      color={v.lift_vs_random > 0 ? 'success' : v.lift_vs_random < 0 ? 'error' : 'default'}
                      label={`무작위 대비 ${v.lift_vs_random >= 0 ? '+' : ''}${v.lift_vs_random.toFixed(2)}`}
                      sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                    />
                    {weak && <Chip size="small" color="error" label="약한 신호 ↓보정" sx={{ height: 18, fontSize: 11, fontWeight: 700 }} />}
                    {strong && <Chip size="small" color="success" label="강한 신호" sx={{ height: 18, fontSize: 11, fontWeight: 700 }} />}
                  </Stack>
                );
              })}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, fontStyle: 'italic' }}>
              ※ {acc.note}
            </Typography>
          </Paper>
        );
      })()}

      <BulkLineInputDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={handleBulkInsert}
        linesPerSlip={GAME_LABELS.length}
      />
      {ConfirmDialog}
    </Paper>
  );
}
