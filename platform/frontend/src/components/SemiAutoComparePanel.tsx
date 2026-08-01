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
  LinearProgress,
  Divider,
  Tab,
  Tabs,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import BulkLineInputDialog, { lineKey } from './BulkLineInputDialog';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import { optimizeForSharing } from '../utils/jackpotSharing';
import {
  buildDetailForecastSnapshot,
  saveDetailForecast,
} from '../utils/detailForecastBridge';
import NumberFrequencyPanel from './NumberFrequencyPanel';
import EngineAuxSignalsPanel from './EngineAuxSignalsPanel';
import {
  ENGINE_BALL,
  EngineSection,
  EngineStatusChip,
  EngineSubBlock,
  EngineTabBanner,
} from './EngineSection';
import {
  generateScoredRecommendations,
  type ScoredRecommendation,
  type ValidatedLearningSignal,
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
import { learnOverlapProfile, rankCurrentByProfile } from '../utils/overlapPatternLearning';
import { scrollToPhotoRecommend, takePhotoFocus } from '../utils/photoFocus';
import MachineOverviewPanel from './MachineOverviewPanel';

const ComposedAnalysisPage = lazy(() => import('../pages/ComposedAnalysisPage'));
const RoundRecommendPage = lazy(() => import('../pages/RoundRecommendPage'));

const NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);

// ── 반자동 비교 영속화 (localStorage) ─────────────────────────────
// 탭별 격리: 복기 / 이번회차 각각 별도 저장 (데이터 오염 방지).
const SEMI_AUTO_STORAGE_PREFIX = 'lotto:semiAuto:v1';

function semiAutoStorageKey(intent: SheetIntent): string {
  return `${SEMI_AUTO_STORAGE_PREFIX}:${intent}`;
}

/**
 * 해당 intent 의 반자동 로컬 누적을 비운다 — 회차 롤오버 정리용.
 *
 * ⚠️ 자동만 지우고 반자동을 남기면 이번회차가 '반자동만 있는' 비대칭 상태가 되어
 * 자동↔반자동 1:1 전수비교에 기반한 모든 섹션(예상번호·심층역산·종합추천·1:1매칭)이
 * 통째로 죽는다. 롤오버 시 반드시 양쪽을 함께 정리해야 한다.
 */
export function clearSemiAutoLocal(intent: SheetIntent): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(semiAutoStorageKey(intent));
  } catch {
    /* quota / private mode — silent */
  }
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

// 대량 임계값(안내용) — 페어 매칭 계산 자체는 가볍다(수십만 페어 ≈ 수십 ms).
// 브라우저 보호는 '데이터 샘플링(상위 N장)'이 아니라 렌더 페이징
// (groupShowLimit / lineRenderCap)으로 한다. 상위 N장만 쓰면 전수비교 결과가
// 왜곡되어 제품 버그가 된다.
const HEAVY_COMPARISON_TICKET_LIMIT = 1_200;
const HEAVY_LINE_PAIR_LIMIT = 200_000;
// 실제 '계산 보류(빈 그룹)' 는 계산이 수 초 걸릴 극단에서만 — 모바일이든 PC든 그
// 미만에선 항상 계산해 파생 분석(예상번호·강수기대·이월·최종)이 보이게 한다.
// (메모리 실측: 모바일 재부팅 원인은 '계산' 이 아니라 '렌더' — 렌더만 캡으로 보호.)
const EXTREME_COMPARISON_TICKET_LIMIT = 6_000;
const EXTREME_LINE_PAIR_LIMIT = 2_000_000;

// 모바일 감지 — 과거 lowMem||lowCpu 단독 true 로 4코어 노트북까지
// '보류'되어 상위 200장 샘플만 보이는 사고가 있었다. 실제 모바일 신호만 사용.
const IS_CONSTRAINED_DEVICE = (() => {
  try {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const smallVp =
      typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 820;
    const coarse =
      typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches;
    return mobileUa || (coarse && smallVp);
  } catch {
    return false;
  }
})();
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
  /**
   * 이 로컬 누적이 '어느 회차 기준' 으로 만들어졌는지. 저장 시점의 대상 회차로 stamp.
   * ⚠️ 이게 없으면 회차가 넘어간 뒤 지난 회차 로컬이 그대로 재저장돼 **새 회차로
   * 재라벨링**된다(실제 오염 사고: 1232 용지 338/291 이 복기 1233 으로 저장됨).
   * roundNo != 현재 대상 회차 이면 재저장을 막고 사용자에게 알린다.
   */
  roundNo: number | null;
};

function defaultPersistedState(): PersistedSemiAutoState {
  return {
    picked: [],
    pickFlags: {},
    bulkTickets: [],
    semiCurrentLines: [],
    semiSlipQueue: [],
    lastSavedAt: null,
    roundNo: null,
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
    const roundNo: number | null =
      typeof obj.roundNo === 'number' && obj.roundNo > 0 ? obj.roundNo : null;

    return {
      picked,
      pickFlags,
      bulkTickets,
      semiCurrentLines,
      semiSlipQueue,
      lastSavedAt,
      roundNo,
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

  // ⚠️ 당첨번호로 강한후보를 가중하지 않는다 — 복기에서 '당첨을 맞힌 것처럼' 보이게
  // 하는 누수(hindsight)였다. 강한후보는 오직 용지 구조(페어·트리플 반복 + 기본
  // 빈도)로만 도출하고, 당첨은 사후 대조·표시에만 쓴다. 그래서 이 함수는 애초에
  // winningNumbers 를 인자로 받지 않는다(재발 방지).
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
    if (ranked.length) return ranked.slice(0, 24);
  }
  return [];
}

function resolveStrongCandidates(
  accumulated: PhotoAnalysisAccumulated | null,
  intent: SheetIntent,
  autoLines: number[][]
): { candidates: number[]; source: 'backend' | 'local' | 'none' } {
  const backend = getIntentStrongCandidates(accumulated, intent);
  if (backend.length > 0) return { candidates: backend, source: 'backend' };
  const local = deriveLocalStrongCandidates(autoLines);
  if (local.length > 0) return { candidates: local, source: 'local' };
  return { candidates: [], source: 'none' };
}

function getIntentExcludedCandidates(
  accumulated: PhotoAnalysisAccumulated | null,
  intent: SheetIntent
): number[] {
  // intent 슬라이스만 사용 — top-level final_predictions 는 복기+이번회차 합산이라
  // 복기 탭에 현재회차 배제가 섞이는 오염을 막는다.
  return accumulated?.by_intent?.[intent]?.final_predictions?.excluded_candidates ?? [];
}

/** 이번회차 용지 없을 때 서버가 넣는 보관회차 시연 추천 — 점수 주입 금지. */
function isArchivedDemoSource(source?: string | null): boolean {
  return typeof source === 'string' && source.startsWith('archived_demo_');
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
  /** ① 번호 등록 — 자동 용지 블록(반자동과 한 Paper) */
  registerPrelude?: ReactNode;
  /** ② 분석 상단 — 자동 빈도 등 */
  analysisPrelude?: ReactNode;
  /** ② 분석 하단(1:1 뒤) — 누적 패턴 · 회차별 용지 데이터 */
  analysisEpilogue?: ReactNode;
  /** ④ 패턴 엔진 안 — 복기검증·백테스트 */
  verificationSlot?: ReactNode;
  /** 엔진② 평행회차 슬롯 */
  parallelEngineSlot?: ReactNode;
  /** 엔진③ 검증학습 슬롯 (Feature·Pattern·다회차·줄겹침) */
  validatedLearningSlot?: ReactNode;
  /** @deprecated parallelEngineSlot + validatedLearningSlot 사용 */
  engineExtraSlot?: ReactNode;
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
    tone: 'success' | 'warning',
    items: PredictionSignalNumber[],
    emptyHint: string,
  ) => (
    <EngineSubBlock
      tone={tone}
      title={title}
      chips={<EngineStatusChip variant="outlined" label={`${items.length}개`} />}
      sx={{ flex: 1, minWidth: 0 }}
    >
      {items.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {emptyHint}
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {items.map((item) => (
            <Box
              key={`explain-${title}-${item.number}`}
              sx={{
                p: 1,
                borderRadius: 1,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                <LottoBall number={item.number} size={ENGINE_BALL.emphasis} />
                <EngineStatusChip
                  label={`${item.grade} · 점수 ${(item.score ?? 0).toFixed(1)}`}
                  sx={{
                    bgcolor: GRADE_COLORS[item.grade],
                    color: item.grade === 'C' ? 'text.primary' : '#fff',
                  }}
                />
                <Typography variant="caption" color="text.secondary">
                  {summarizeSignalReason(item)}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {item.sources.map((src) => (
                  <EngineStatusChip
                    key={`src-${item.number}-${src}`}
                    variant="outlined"
                    label={
                      predictionSignals?.source_weights?.[src] != null
                        ? `${signalSourceLabel(src)} (+${(predictionSignals.source_weights[src] ?? 0).toFixed(1)})`
                        : signalSourceLabel(src)
                    }
                  />
                ))}
                {item.excluded_by.map((src) => (
                  <EngineStatusChip
                    key={`exc-${item.number}-${src}`}
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
    </EngineSubBlock>
  );

  return (
    <Stack spacing={1.25} sx={{ mt: 1.25 }}>
      <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
        <Typography variant="caption" fontWeight={800}>
          왜 이 번호가 나왔나요?
        </Typography>
        <EngineStatusChip variant="outlined" label="근거 분해" />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        강한 후보는 점수·계열 합의로, 배제 후보는 exclusion 신호가 붙은 번호로 설명합니다.
      </Typography>
      {usingFallback && (
        <Alert severity="info" sx={{ py: 0.5 }}>
          통합 신호 상세가 비어 있어 현재 화면에서 사용 중인 강한 후보를 로컬/누적 기준으로 설명합니다.
        </Alert>
      )}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
        {renderItems('강한 후보 근거', 'success', strongItems, '표시할 강한 후보 근거가 없습니다.')}
        {renderItems('배제 후보 근거', 'warning', excludedItems, '표시할 배제 후보 근거가 없습니다.')}
      </Stack>
    </Stack>
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
  registerPrelude = null,
  analysisPrelude = null,
  analysisEpilogue = null,
  verificationSlot = null,
  parallelEngineSlot = null,
  validatedLearningSlot = null,
  engineExtraSlot = null,
}: SemiAutoComparePanelProps) {
  const { confirm, ConfirmDialog } = useConfirm();
  const lineMatchingRef = useRef<HTMLDivElement | null>(null);
  const [lineMatchFilter, setLineMatchFilter] = useState<'all' | 2 | 3 | 4 | 5 | 6>('all');
  const [lineMatchNumberFilter, setLineMatchNumberFilter] = useState('');
  // 1:1 매칭 그룹을 '반자동 측 일치 줄 수'로 정렬 — none(기본: matchCount·지지순)/desc(많은순)/asc(적은순).
  const [semiLineSort, setSemiLineSort] = useState<'none' | 'desc' | 'asc'>('none');
  // 1:1 매칭 그룹 카드 렌더 페이지네이션 — 한 번에 모든 그룹(수백)×모든 줄을 DOM 에
  // 올리면 모바일이 OOM 재부팅한다. 레벨당 이만큼만 렌더하고 [더 보기]로 늘린다.
  const [groupShowLimit, setGroupShowLimit] = useState(IS_CONSTRAINED_DEVICE ? 10 : 60);
  // 한 그룹 카드에서 렌더할 자동/반자동 줄 수 상한(모바일은 더 작게, [더 보기]로 확장).
  const lineRenderCap = IS_CONSTRAINED_DEVICE ? 6 : GROUP_LINE_RENDER_CAP;
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
  /** 이 로컬 누적이 만들어진 대상 회차 — 회차 넘어간 뒤 재저장(재라벨링) 방지용. */
  const [localRoundNo, setLocalRoundNo] = useState<number | null>(initial.roundNo);
  const [compareRound, setCompareRound] = useState<number | null>(null);
  /**
   * 모바일+대량에서 자동 보류된 뒤 사용자가 [전체 전수비교 실행]을 누르면
   * 전체 줄·전체 페어로 1:1 전수비교·교집합 요약을 모두 계산한다.
   * (샘플링/상위 N장 없음 — 분석 왜곡 방지)
   */
  const [forceDetailedComparison, setForceDetailedComparison] = useState(false);
  // 섹션 접힘/펼침 — ①·③ 기본 펼침. ③ 안 추천 상세(강수·기대·종합)는 접기 없음.
  const [showRegister, setShowRegister] = useState(true);
  const [showAnalysisSection, setShowAnalysisSection] = useState(false);
  const [showRecommendSection, setShowRecommendSection] = useState(true);
  /** 구 상단탭 종합분석 → ③ Venus 임베드 (기본 접힘, 딥링크 시 자동 펼침) */
  const [showCompositeEmbed, setShowCompositeEmbed] = useState(false);
  const [showPredictionDetail, setShowPredictionDetail] = useState(false);
  const [showTicketCompare, setShowTicketCompare] = useState(false);
  /** 1:1 전수비교 상세(매칭 카드) — 요약만 기본, 상세 보기로 펼침 */
  const [showLineMatchDetail, setShowLineMatchDetail] = useState(false);
  /** 학습 엔진 | 호기·후속 | 검증 — 용지미출 탭/섹션 없음. 호기 패턴은 여기(aux)만. */
  const [engineTab, setEngineTab] = useState<'learn' | 'aux' | 'verify'>('learn');

  // 탭 전환 시 해당 탭 전용 localStorage 로드
  useEffect(() => {
    const st = loadSemiAutoState(sheetIntent);
    setPicked(st.picked);
    setBulkTickets(st.bulkTickets);
    setSemiCurrentLines(st.semiCurrentLines);
    setSemiSlipQueue(st.semiSlipQueue);
    setLastSavedAt(st.lastSavedAt);
    setLocalRoundNo(st.roundNo);
    setCompareRound(null);
    setForceDetailedComparison(false);
    // 탭 전환 시 이전 탭의 추천 조합을 비운다 — 남겨두면 winningSet 의미가 바뀐 채
    // (복기↔이번회차) 옛 조합의 '당첨 N/6'·dim 이 오해를 부른다.
    setRecommendations([]);
  }, [sheetIntent]);

  // 구 상단탭(종합분석/추첨기추천) → 용지분석 딥링크
  // composite → ③ Venus · machine → ④ 후속·gap 호기 · recommend → ③ 번호추천
  useEffect(() => {
    const focus = takePhotoFocus();
    if (!focus) return;
    if (focus === 'composite') {
      setShowRecommendSection(true);
      setShowCompositeEmbed(true);
      window.setTimeout(() => scrollToPhotoRecommend({ embed: 'composite' }), 120);
    } else if (focus === 'machine') {
      setShowPredictionDetail(true);
      setEngineTab('aux');
      window.setTimeout(() => scrollToPhotoRecommend({ embed: 'machine' }), 120);
    } else {
      setShowRecommendSection(true);
      window.setTimeout(() => scrollToPhotoRecommend(), 80);
    }
  }, []);

  // 영속 — picked / bulkTickets / semiCurrentLines / semiSlipQueue / lastSavedAt / roundNo
  useEffect(() => {
    saveSemiAutoState(sheetIntent, {
      picked,
      pickFlags: {},
      bulkTickets,
      semiCurrentLines,
      semiSlipQueue,
      lastSavedAt,
      roundNo: localRoundNo,
    });
  }, [sheetIntent, picked, bulkTickets, semiCurrentLines, semiSlipQueue, lastSavedAt, localRoundNo]);

  // 기기 간 동기화 — 로컬(이 기기)이 비어 있으면 서버 저장분(saved_semi_lines)을
  // 반자동 누적으로 복원. 로컬에 데이터가 있으면 덮어쓰지 않는다. intent별 1회만.
  const hydratedIntentRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const serverLines = accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines ?? [];
    if (!serverLines.length || hydratedIntentRef.current[sheetIntent]) return;
    const localEmpty =
      bulkTickets.length === 0 &&
      semiSlipQueue.length === 0 &&
      semiCurrentLines.length === 0;
    if (localEmpty) {
      hydratedIntentRef.current[sheetIntent] = true;
      setBulkTickets(serverLines.map((a) => [...a]));
      // 서버 복원분은 '이미 저장된' 데이터 → lastSavedAt 도 세팅해 '미저장' 오표기
      // 방지(자동 하이드레이션과 대칭). 이게 없으면 새 기기에서 반자동만 '미저장'
      // 으로 보여 '동기화 안 됨'처럼 오해되고, 재저장을 유발했다.
      setLastSavedAt((prev) => prev ?? new Date().toISOString());
      // 서버 복원분은 그 슬라이스(=현재 대상 회차) 기준 데이터 → 회차 stamp 도 맞춘다.
      // (effectiveRound 는 아래서 계산되므로 슬라이스 ticket_round 를 우선 사용)
      const stampRaw = accumulated?.by_intent?.[sheetIntent]?.ticket_round;
      const stampN = stampRaw != null ? parseInt(String(stampRaw), 10) : NaN;
      setLocalRoundNo(Number.isFinite(stampN) && stampN > 0 ? stampN : null);
      setSaveNotice(
        `☁ 다른 기기에서 저장한 반자동 누적 ${serverLines.length}줄을 서버에서 불러왔습니다.`
      );
    }
  }, [accumulated, sheetIntent, bulkTickets.length, semiSlipQueue.length, semiCurrentLines.length]);

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

  // 복기 비교 기준 회차 — 백엔드가 복기 엔트리 기준으로 stamp 한 회차(정합성).
  // 사용자가 '비교 회차'를 직접 지정하지 않았을 때, 복기 용지는 '최신 추첨 회차'가
  // 아니라 '그 용지가 속한 회차'의 당첨번호와 대조해야 한다(예: 1231 용지는 1231 당첨).
  const reviewDataRound = useMemo(() => {
    const raw = accumulated?.by_intent?.review?.ticket_round;
    const n = raw != null ? parseInt(String(raw), 10) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
    // 고아 복기 삭제 후 live 복기가 비면 최신 보관 회차를 대조 기준으로 사용.
    const archived = accumulated?.historical_dataset?.latest_archived_round;
    const a = archived != null ? parseInt(String(archived), 10) : NaN;
    return Number.isFinite(a) && a > 0 ? a : null;
  }, [accumulated]);

  // 명시 지정(compareRound) > 복기 데이터 회차 > (폴백) 최신 추첨.
  const effectiveCompareRound = compareRound ?? (compareWinning ? reviewDataRound : null);

  const selectedRoundQuery = useQuery({
    queryKey: ['v1-round-for-semi-auto', effectiveCompareRound],
    queryFn: () => v1Api.getRound(effectiveCompareRound as number),
    enabled: compareWinning && !!effectiveCompareRound,
    staleTime: 60_000,
    retry: false,
  });

  const comparisonRoundData = compareWinning
    ? effectiveCompareRound != null
      ? selectedRoundQuery.data
      : latest.data
    : null;
  const effectiveRound = compareWinning
    ? effectiveCompareRound ?? latest.data?.round ?? latestRound
    : currentRound;

  // 복기 당첨: API 회차 우선, 없으면 저장소 draw_template(용지에 이미 있는 당첨)로 시드.
  // getRound 실패·로딩 중에도 당첨 대조·dimming 이 비지 않게 한다(PhotoAnalysisPage 와 동일).
  const reviewTemplate = accumulated?.by_intent?.review?.draw_template;
  const winningNumbers = compareWinning
    ? (comparisonRoundData?.numbers?.length
        ? comparisonRoundData.numbers
        : (reviewTemplate?.winning_numbers ?? []))
    : [];
  const winningBonus = compareWinning
    ? (comparisonRoundData?.bonus ?? reviewTemplate?.bonus ?? null)
    : null;

  // 하이드레이션·로컬 입력 후 회차 stamp 가 비어 있으면 effectiveRound 로 보정.
  useEffect(() => {
    if (localRoundNo != null || effectiveRound == null) return;
    const hasLocal =
      bulkTickets.length > 0 || semiSlipQueue.length > 0 || semiCurrentLines.length > 0;
    if (hasLocal) setLocalRoundNo(effectiveRound);
  }, [effectiveRound, localRoundNo, bulkTickets.length, semiSlipQueue.length, semiCurrentLines.length]);

  const intentSectionLabel = sheetIntent === 'review' ? '복기' : '이번회차';
  /** 복기=그 회차 용지 추천(당첨 대조) / 이번회차=미추첨 회차 추천 — 탭별로 대상·픽이 다름. */
  const recommendHeroTitle = compareWinning
    ? `🎯 복기 ${effectiveRound ?? '?'}회 검증 추천`
    : `🎯 ${currentRound ?? effectiveRound ?? '?'}회 이번회차 핵심 추천`;
  const recommendHeroHint = compareWinning
    ? `복기 ${effectiveRound ?? '?'}회 용지·신호로 만든 추천입니다. 당첨번호와 대조합니다(이번회차 ${currentRound ?? '?'}회 픽과 다름).`
    : `복기 검증을 근거로 ${currentRound ?? effectiveRound ?? '?'}회 이번회차 추천을 만듭니다.`;

  // 로컬 누적이 '지난 회차 기준' 인지 판정 — 회차가 넘어간 뒤 그대로 재저장하면
  // 서버에 **새 회차로 재라벨링**되어 데이터가 오염된다(실제 사고: 1232 용지가
  // 복기 1233 으로 저장됨). stamp 된 회차와 현재 대상 회차가 다르면 저장을 막는다.
  const localLineTotal =
    bulkTickets.length +
    semiSlipQueue.reduce((s, sl) => s + sl.lines.length, 0) +
    semiCurrentLines.length;
  const staleLocalRound =
    localRoundNo != null &&
    effectiveRound != null &&
    localRoundNo !== effectiveRound &&
    localLineTotal > 0;

  // 복기 회차 롤오버 자기치유 — 새 회차가 추첨되면 서버 복기 슬라이스는 다음 회차로
  // 넘어가는데(예: 1233→1234) 브라우저의 반자동 복기 localStorage 는 intent 로만
  // 키잉돼 옛 회차(1233) 용지·회차 stamp 가 그대로 남는다. 그러면 하이드레이션
  // 가드(localEmpty)가 서버 최신(1234)을 안 불러오고, 옛 1233 용지를 새 회차(1234)
  // 당첨번호와 대조해 '아직 1233 데이터'·'특정 구간 당첨률 저조'로 보인다(실제 사고).
  // 이미 저장된(lastSavedAt) 로컬이 서버 복기 회차보다 과거이면 서버 최신으로 교체한다.
  const rolloverHealedRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (sheetIntent !== 'review') return;
    const serverRound = reviewDataRound;
    const serverLines = accumulated?.by_intent?.review?.saved_semi_lines ?? [];
    const staleBehind =
      localRoundNo != null &&
      serverRound != null &&
      localRoundNo < serverRound &&
      lastSavedAt != null &&
      localLineTotal > 0;
    if (!staleBehind || rolloverHealedRef.current[sheetIntent]) return;
    rolloverHealedRef.current[sheetIntent] = true;
    // 이후 기기간 하이드레이션도 중복 실행 안 되게 잠근다(여기서 서버분을 채운다).
    hydratedIntentRef.current[sheetIntent] = true;
    const prevRound = localRoundNo;
    setBulkTickets(serverLines.map((a) => [...a]));
    setSemiSlipQueue([]);
    setSemiCurrentLines([]);
    setPicked([]);
    setLocalRoundNo(serverRound);
    setLastSavedAt(serverLines.length ? new Date().toISOString() : null);
    setSaveNotice(
      serverLines.length
        ? `♻ 복기 회차가 ${serverRound}회로 넘어가 이전 회차(${prevRound}회) 반자동 로컬을 서버 최신 ${serverLines.length}줄로 교체했습니다.`
        : `♻ 복기 회차가 ${serverRound}회로 넘어가 이전 회차(${prevRound}회) 반자동 로컬을 비웠습니다.`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accumulated, sheetIntent, reviewDataRound, localRoundNo, lastSavedAt, localLineTotal]);

  // 이번회차 회차 롤오버 자기치유 — 새 회차가 추첨되면(currentRound 전진) 이번회차 탭의
  // 반자동 로컬은 옛 회차(예: 1235) 용지·stamp 를 그대로 물고 있어 '반자동이 이번회차에
  // 남고 복기로 안 넘어간다'. 자동(§1)은 PhotoAnalysisPage rolloverClearedRef 가 자동
  // 드래프트를 비우고 clearSemiAutoLocal('current_round') 로 반자동 localStorage 도
  // 지우지만, **마운트된 이 패널의 React state(semiCurrentLines/semiSlipQueue/bulkTickets)
  // 는 그대로 남는다**(localStorage 만 지워도 화면 state 는 안 바뀜) — 그게 이번 버그.
  // 서버는 롤오버로 그 회차 용지를 보관(복기에 노출)하므로, 이미 저장된(lastSavedAt) 이번
  // 회차 로컬에 한해 비우고 새 회차 기준으로 다시 시작한다(미저장 작업물은 보존).
  const currentRolloverHealedRef = useRef<number | null>(null);
  useEffect(() => {
    if (sheetIntent !== 'current_round' || currentRound == null) return;
    if (localLineTotal === 0 || lastSavedAt == null) return; // 저장분만 정리(미저장 보존)
    // (1) 회차 stamp 가 현재 이번회차보다 과거 → 확실히 롤오버됨.
    const stampStale = localRoundNo != null && localRoundNo < currentRound;
    // (2) stamp 없는 레거시 저장분 → 서버 이번회차가 비었고 복기에 반자동이 있으면 롤오버 완료.
    const serverCur = accumulated?.by_intent?.current_round;
    const serverRev = accumulated?.by_intent?.review;
    const legacyRolled =
      localRoundNo == null &&
      (serverCur?.saved_semi_lines?.length ?? 0) === 0 &&
      (serverRev?.saved_semi_lines?.length ?? 0) > 0;
    if ((!stampStale && !legacyRolled) || currentRolloverHealedRef.current === currentRound) return;
    currentRolloverHealedRef.current = currentRound;
    hydratedIntentRef.current[sheetIntent] = true; // 방금 비웠으니 재하이드레이션 중복 방지
    const prevRound = localRoundNo;
    setBulkTickets([]);
    setSemiSlipQueue([]);
    setSemiCurrentLines([]);
    setPicked([]);
    setLocalRoundNo(currentRound);
    setLastSavedAt(null);
    setSaveNotice(
      `🔄 ${prevRound != null ? `${prevRound}회` : '지난 회차'}가 추첨 완료되어 이번회차 반자동 입력이 복기로 이동했습니다. 이번회차를 ${currentRound}회 기준으로 새로 시작합니다.`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetIntent, currentRound, localRoundNo, lastSavedAt, localLineTotal, accumulated]);

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
  // 대량 여부(안내용). 계산(그룹·파생신호)은 모바일에서도 보류하지 않는다 — 예상번호·
  // 강수/기대·이월·최종강수가 모바일에서도 항상 보이게. 진짜 보류(빈 그룹)는 계산이 수 초
  // 걸릴 '극단' 에서만(디바이스 무관 백스톱). 무거운 카드 목록 렌더는 groupShowLimit/
  // lineRenderCap 로 보호한다(모바일 OOM 방지). ← 메모리 실측 결론 복원.
  const isHeavyVolume =
    combinedTicketEstimate > HEAVY_COMPARISON_TICKET_LIMIT ||
    estimatedLinePairCount > HEAVY_LINE_PAIR_LIMIT;
  const isExtremeVolume =
    combinedTicketEstimate > EXTREME_COMPARISON_TICKET_LIMIT ||
    estimatedLinePairCount > EXTREME_LINE_PAIR_LIMIT;
  const suspendHeavyComparison = isExtremeVolume && !forceDetailedComparison;

  const strongCandidateResolution = useMemo(
    () => resolveStrongCandidates(accumulated, sheetIntent, autoOnlyLines),
    [accumulated, sheetIntent, autoOnlyLines]
  );

  // 통합 신호: 복기=검증 회차·그 호기 / 이번회차=미추첨 회차·그 호기 (예: 1234·1호기 vs 1235·2호기)
  const predictionSignalsQuery = useQuery({
    queryKey: ['v1-prediction-signals', sheetIntent, effectiveRound ?? 'auto'],
    queryFn: () =>
      v1Api.getPredictionSignals(
        sheetIntent,
        undefined,
        effectiveRound ?? undefined,
      ),
    enabled: effectiveRound != null || sheetIntent === 'current_round' || sheetIntent === 'review',
    staleTime: 120_000,
    retry: 1,
  });
  const predictionSignals = predictionSignalsQuery.data ?? null;

  // 종합 추천/예상번호의 보조 축 — 평행회차 강수/기대수(주 축은 자동↔반자동 1:1).
  const parallelRoundQuery = useQuery({
    queryKey: ['v1-parallel-round', effectiveRound ?? 'auto'],
    queryFn: () => v1Api.getParallelRoundAnalysis(effectiveRound ?? undefined),
    staleTime: 300_000,
    retry: 1,
  });
  const parallelStrong = parallelRoundQuery.data?.parallel_strong ?? [];
  const parallelExpected = parallelRoundQuery.data?.parallel_expected ?? [];
  // 호기(추첨기) 축은 '추정값' 신뢰도 문제로 제외(사용자 요청). 예측은 자동↔반자동
  // 1:1 전수비교 + 평행회차 두 축으로만 진행한다. (안정 참조로 빈 배열 고정.)
  const machineStrong = useMemo<number[]>(() => [], []);

  // ✅ 복기 학습 패널(Feature/Round/Overlap/ReviewVerification) → 예상·추천에 반영.
  // 검증 통과·기준선 이상만 validatedLearning 으로 주입한다.
  const featureLearningQuery = useQuery({
    queryKey: ['v1-photo-feature-learning', 'current_round', 'semi-auto'],
    queryFn: () => v1Api.getFeatureLearning(42, { applyIntent: 'current_round' }),
    staleTime: 300_000,
    retry: 1,
  });
  const roundLearningQuery = useQuery({
    queryKey: ['v1-photo-round-learning', 'current_round', 'semi-auto'],
    queryFn: () => v1Api.getRoundLearning({ applyIntent: 'current_round' }),
    staleTime: 300_000,
    retry: 1,
  });
  const reviewVerificationQuery = useQuery({
    // ReviewVerificationPanel 과 동일 키 — 패널/주입 캐시 분열(정책·expand18 불일치) 방지.
    queryKey: ['v1-photo-review-verification', 'expand24-v4', 'semi-freq-v1', 'pair-product'],
    queryFn: v1Api.getReviewVerification,
    staleTime: 60_000,
    retry: 1,
  });
  const graftCoverageQuery = useQuery({
    queryKey: ['v1-photo-graft-coverage', 'graft-v3-raw-first', sheetIntent],
    queryFn: () =>
      v1Api.getGraftCoverage(sheetIntent === 'review' ? 'review' : 'current_round'),
    staleTime: 60_000,
    retry: 1,
  });
  const overlapLearningQuery = useQuery({
    // 주입은 항상 이번회차 적용 — 복기 탭 패널 캐시와 분리
    queryKey: ['v1-photo-overlap-learning', 'current_round', 'semi-auto'],
    queryFn: () => v1Api.getOverlapLearning({ applyIntent: 'current_round' }),
    staleTime: 300_000,
    retry: 1,
  });
  const patternMiningQuery = useQuery({
    queryKey: ['v1-photo-pattern-mining', 'current_round', 'semi-auto'],
    queryFn: () => v1Api.getPatternMining(42, { applyIntent: 'current_round' }),
    staleTime: 300_000,
    retry: 1,
  });
  const carryoverQuery = useQuery({
    queryKey: ['v1-photo-carryover-learning', 'semi-auto'],
    queryFn: () => v1Api.getCarryoverLearning(42),
    staleTime: 300_000,
    retry: 1,
  });

  const validatedLearning = useMemo((): ValidatedLearningSignal[] => {
    const byKey = new Map<string, ValidatedLearningSignal>();
    const push = (n: number, weight: number, source: ValidatedLearningSignal['source'], label: string) => {
      if (!Number.isInteger(n) || n < 1 || n > 45 || weight <= 0) return;
      const key = `${source}:${n}`;
      const prev = byKey.get(key);
      if (prev) {
        // 같은 source·번호는 가중 합산(커버리지 expand+core 가산 등). cap 1.
        prev.weight = Math.max(0, Math.min(1, prev.weight + weight));
        return;
      }
      byKey.set(key, { number: n, weight: Math.max(0, Math.min(1, weight)), source, label });
    };

    // 이번회차 전용 학습(다음 회차 적용) — 복기 탭에 넣으면 양 탭 추천이 같아진다.
    const forwardLearning = sheetIntent === 'current_round';

    const feat = featureLearningQuery.data;
    // archived_demo_* = 이번회차 용지 없을 때 보관회차 시연 — 점수 주입 금지(오염).
    if (
      forwardLearning &&
      feat?.ok &&
      feat.recommendation?.ok &&
      !isArchivedDemoSource(feat.recommendation.source)
    ) {
      const nums = feat.recommendation.numbers ?? [];
      const maxAbs = Math.max(0.01, ...nums.map((x) => Math.abs(x.score)));
      for (const row of nums.slice(0, 24)) {
        push(row.number, 0.35 + 0.65 * (Math.abs(row.score) / maxAbs), 'feature', '검증Feature');
      }
    }

    const rl = roundLearningQuery.data;
    // V3 다회차: 평탄(calibration_flat)이면 구간 신호가 없으므로 주입 안 함 — 겹침/이월과 대칭.
    if (
      forwardLearning &&
      rl?.ok &&
      !rl.summary?.calibration_flat &&
      (rl.current_scores?.length ?? 0) > 0
    ) {
      const maxScore = Math.max(1, ...rl.current_scores!.map((s) => s.score));
      for (const s of rl.current_scores!.slice(0, 15)) {
        if ((s.learned_lift ?? 1) < 1.05) continue;
        push(s.number, 0.3 + 0.7 * (s.score / maxScore), 'round', '다회차학습');
      }
    }

    const ov = overlapLearningQuery.data;
    // calibration_flat(신호 없음/표본 부족)이면 서버 겹침학습을 주입하지 않는다.
    let serverOverlapOn = false;
    if (forwardLearning && ov?.ok && !ov.calibration_flat && (ov.current_scores?.length ?? 0) > 0) {
      serverOverlapOn = true;
      const maxScore = Math.max(1, ...ov.current_scores!.map((s) => s.score));
      for (const s of ov.current_scores!.slice(0, 12)) {
        push(s.number, 0.3 + 0.7 * (s.score / maxScore), 'overlap', '겹침학습');
      }
    }
    // V4-B 클라이언트: V4-A 서버가 없거나 평탄일 때만 약한 fallback(완전일치 드묾 보완).
    if (forwardLearning && !serverOverlapOn && accumulated) {
      const reviewSlice = accumulated.by_intent?.review;
      const currentSlice = accumulated.by_intent?.current_round;
      const profile = learnOverlapProfile(
        reviewSlice?.accumulated_combo_patterns ?? null,
        reviewSlice?.draw_template?.winning_numbers ?? null
      );
      if (profile.confidence !== 'none') {
        const ranked = rankCurrentByProfile(currentSlice?.accumulated_combo_patterns ?? null, profile);
        if (ranked.length) {
          const maxScore = Math.max(1, ...ranked.map((r) => r.score));
          const scale = profile.confidence === 'medium' ? 0.55 : 0.35;
          for (const r of ranked.slice(0, 10)) {
            push(r.number, scale * (0.3 + 0.7 * (r.score / maxScore)), 'overlap', '줄겹침학습');
          }
        }
      }
    }

    const rv = reviewVerificationQuery.data;
    // 이번회차만 커버리지 점수 주입 — 복기 탭에 넣으면 같은 용지 세트로 점수를 끌어
    // '검증이 스스로 자신을 강화'하는 순환이 된다. 복기 커버리지는 히어로 표시만.
    // 역산 정책: core6=best 단일신호, expand18=min-rank(합의 희석 금지).
    const cov = forwardLearning ? rv?.current_coverage_set : undefined;
    const consensus = forwardLearning ? rv?.consensus_coverage : undefined;
    if (forwardLearning && rv?.ok && (cov || consensus)) {
      const policy = rv.inverse_diagnosis?.policy;
      // prefer_consensus 는 항상 false(하위호환). core6/expand18 모드는 정책 명시값 우선.
      const coreMode = policy?.core6_mode ?? (policy?.prefer_consensus ? 'consensus' : 'best_single');
      const expandMode = policy?.expand18_mode ?? 'best_of_engines';
      const core =
        coreMode === 'consensus'
          ? (consensus?.core6 ?? cov?.core6 ?? [])
          : (cov?.core6 ?? consensus?.core6 ?? []);
      // best_of_engines / coverage expand 는 서버 cov.expand18(min-rank). 합의는 폴백만.
      const expand =
        expandMode === 'consensus'
          ? (consensus?.expand18 ?? cov?.expand18 ?? [])
          : (cov?.expand18 ?? consensus?.expand18 ?? []);
      // 다회차 최선 신호 mean_top18 기반 신뢰도(단일회차 summary 보다 안정). 정책값 우선.
      const multiConf = policy?.multi_round_confidence;
      const bestTop18 =
        multiConf != null
          ? null
          : (rv.signal_leaderboard?.leaderboard?.find((e) => e.key === rv.signal_leaderboard?.best_signal_multi)?.mean_top18
            ?? rv.summary?.best_top18
            ?? 0);
      const randomExp18 = (18 * 6) / 45; // ≈ 2.4
      const covConf =
        multiConf != null
          ? Math.max(0, Math.min(1, multiConf))
          : Math.max(0, Math.min(1, ((bestTop18 ?? 0) - randomExp18) / (6 - randomExp18)));
      const coreScale = policy?.core6_weight_scale ?? 0.55;
      const expandScale = policy?.expand18_weight_scale ?? 0.7;
      if (covConf > 0) {
        // expand18_first: 넓은 그물에 더 높은 가중 — 집중 실패를 주입에서 강화하지 않음.
        for (const n of expand) push(n, 0.7 * expandScale * covConf, 'coverage', '확장망');
        for (const n of core) {
          // core 는 expand 에 이미 들어간 경우가 많아 가산만(중복 push 허용 — weight 합산).
          push(n, 0.35 * coreScale * covConf, 'coverage', '핵심6');
        }
      }
    }

    const pm = patternMiningQuery.data;
    if (
      forwardLearning &&
      pm?.ok &&
      pm.recommendation?.ok &&
      !isArchivedDemoSource(pm.recommendation.source)
    ) {
      const nums = pm.recommendation.numbers ?? [];
      const maxScore = Math.max(0.01, ...nums.map((x) => Math.abs(x.score)));
      for (const row of nums.slice(0, 15)) {
        push(row.number, 0.4 + 0.6 * (Math.abs(row.score) / maxScore), 'pattern', '검증Pattern');
      }
    }

    const co = carryoverQuery.data;
    // 이월(carryover)은 재현되는 초과(lift≥1.15, calibration_flat=false)가 있을 때만
    // 순위 가산 — 평탄(무작위 수준)이면 넣지 않는다(overlap 게이트와 대칭). 로또는
    // 독립시행이라 대개 평탄이며, 그땐 '참고' 섹션에만 표시하고 점수엔 미반영.
    if (forwardLearning && co?.ok && !co.calibration_flat && (co.current_candidates?.length ?? 0) > 0) {
      for (const c of co.current_candidates!.slice(0, 12)) {
        push(c.number, 0.3 + 0.5 * c.score, 'carryover', '이월');
      }
    }

    return Array.from(byKey.values()).sort((a, b) => b.weight - a.weight);
  }, [
    sheetIntent,
    accumulated,
    featureLearningQuery.data,
    roundLearningQuery.data,
    overlapLearningQuery.data,
    reviewVerificationQuery.data,
    patternMiningQuery.data,
    carryoverQuery.data,
  ]);

  const learningBridgeStatus = useMemo(() => {
    const rv = reviewVerificationQuery.data;
    const policy = rv?.ok ? rv.inverse_diagnosis?.policy : undefined;
    const multiConf = policy?.multi_round_confidence;
    const bestTop18 = rv?.ok
      ? (rv.signal_leaderboard?.leaderboard?.find((e) => e.key === rv.signal_leaderboard?.best_signal_multi)?.mean_top18
        ?? rv.summary?.best_top18
        ?? 0)
      : 0;
    const randomExp18 = (18 * 6) / 45;
    const forwardOnly = sheetIntent === 'current_round';
    // 점수 주입과 동일: 이번회차 커버리지만 wired. 복기는 히어로 표시만.
    const covWired = Boolean(
      forwardOnly && (rv?.consensus_coverage?.expand18?.length || rv?.current_coverage_set)
    );
    const coverageConf = covWired
      ? Math.round(
          Math.max(
            0,
            Math.min(
              1,
              multiConf != null
                ? multiConf
                : (bestTop18 - randomExp18) / (6 - randomExp18)
            )
          ) * 100
        )
      : 0;
    const countSrc = (src: ValidatedLearningSignal['source']) =>
      validatedLearning.filter((v) => v.source === src).length;
    const ovFlat = Boolean(overlapLearningQuery.data?.ok && overlapLearningQuery.data.calibration_flat);
    const coFlat = carryoverQuery.data?.ok ? (carryoverQuery.data.calibration_flat ?? true) : true;
    /** L10 ↔ 점수 경로 상태(내부). UI 전용 섹션은 두지 않음. */
    const countLabel = (label: string) => validatedLearning.filter((v) => v.label === label).length;
    const serverOverlapCount = countLabel('겹침학습');
    const clientOverlapCount = countLabel('줄겹침학습');
    const injectRows: {
      id: string;
      label: string;
      status: 'on' | 'off' | 'direct' | 'display';
      count: number;
      note: string;
    }[] = [
      {
        id: '평행',
        label: '평행회차(엔진②)',
        status: parallelStrong.length > 0 || parallelExpected.length > 0 ? 'direct' : 'off',
        count: parallelStrong.length + parallelExpected.length,
        note: '엔진② · validatedLearning 아님 → L1·추천 직접',
      },
      {
        id: 'V1',
        label: 'Feature',
        status: forwardOnly && countSrc('feature') > 0 ? 'on' : 'off',
        count: countSrc('feature'),
        note: forwardOnly ? '이번회차만 주입' : '복기 탭 미주입(탭 분리)',
      },
      {
        id: 'V2',
        label: 'Pattern',
        status: forwardOnly && countSrc('pattern') > 0 ? 'on' : 'off',
        count: countSrc('pattern'),
        note: forwardOnly ? '이번회차만 주입' : '복기 탭 미주입(탭 분리)',
      },
      {
        id: 'V3',
        label: '다회차 지지',
        status: forwardOnly && countSrc('round') > 0 ? 'on' : 'off',
        count: countSrc('round'),
        note: forwardOnly ? '평탄OFF · lift≥1.05' : '복기 탭 미주입',
      },
      {
        id: 'V4-A',
        label: '줄겹침(서버)',
        status: forwardOnly && serverOverlapCount > 0 ? 'on' : 'off',
        count: serverOverlapCount,
        note: ovFlat
          ? '평탄→서버 미주입'
          : forwardOnly
            ? 'V4 우선 소스'
            : '복기 탭 미주입',
      },
      {
        id: 'V4-B',
        label: '줄겹침(클라)',
        status: clientOverlapCount > 0 ? 'on' : serverOverlapCount > 0 ? 'display' : forwardOnly ? 'off' : 'display',
        count: clientOverlapCount,
        note:
          clientOverlapCount > 0
            ? 'V4-A 부재·평탄 시 fallback'
            : 'V4-A 우선 · 화면 채점',
      },
      {
        id: '커버리지',
        label: '커버리지',
        status: forwardOnly && countSrc('coverage') > 0 ? 'on' : 'off',
        count: countSrc('coverage'),
        note: forwardOnly ? '이번회차 용지 세트' : '복기=히어로 표시만(점수 미주입)',
      },
      {
        id: '이월',
        label: '이월',
        status: forwardOnly && !coFlat && countSrc('carryover') > 0 ? 'on' : 'off',
        count: countSrc('carryover'),
        note: coFlat ? '평탄→참고 배지만' : forwardOnly ? '이번회차만' : '복기 탭 미주입',
      },
    ];
    return {
      validatedCount: validatedLearning.length,
      adoptedFeatures: featureLearningQuery.data?.adopted_count ?? 0,
      adoptedPatterns: patternMiningQuery.data?.adopted_count ?? 0,
      roundLearningRounds: roundLearningQuery.data?.ok ? (roundLearningQuery.data.round_count ?? 0) : 0,
      overlapRounds: overlapLearningQuery.data?.ok ? (overlapLearningQuery.data.round_count ?? 0) : 0,
      overlapFlat: ovFlat,
      coverageWired: covWired,
      coverageConf,
      carryoverPairs: carryoverQuery.data?.ok ? (carryoverQuery.data.backtest?.pairs ?? 0) : 0,
      carryoverFlat: coFlat,
      forwardOnly,
      injectRows,
      destinations: [
        'L1-B 교차검증(+소량)',
        '③ 최종 강수·기대 재정렬',
        '③ 추천 5세트(generateScoredRecommendations)',
      ] as const,
      notInjected: ['L1-A 상위순위(순수 1:1)', 'L9 통합신호(서버 독립)', '히어로 핵심6(커버리지 서버)'] as const,
    };
  }, [
    sheetIntent,
    validatedLearning,
    featureLearningQuery.data,
    patternMiningQuery.data,
    roundLearningQuery.data,
    overlapLearningQuery.data,
    reviewVerificationQuery.data,
    carryoverQuery.data,
    parallelStrong.length,
    parallelExpected.length,
  ]);

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
        qc.invalidateQueries({ queryKey: ['v1-photo-review-verification'] }),
        qc.invalidateQueries({ queryKey: ['v1-photo-feature-learning'] }),
        qc.invalidateQueries({ queryKey: ['v1-photo-round-learning'] }),
        qc.invalidateQueries({ queryKey: ['v1-photo-overlap-learning'] }),
        qc.invalidateQueries({ queryKey: ['v1-photo-pattern-mining'] }),
        qc.invalidateQueries({ queryKey: ['v1-photo-carryover-learning'] }),
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
      await qc.refetchQueries({ queryKey: ['v1-photo-review-verification'] });
      setRecommendations([]);
      setReanalyzeNotice('✅ 재분석 완료 — 당첨번호·서버 누적·통계·학습 신호를 갱신했습니다.');
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
  // ⚙ 반자동 추가 세팅 목록 렌더 캡 — 자동(§1)과 동일. 수백 줄 한 번에 마운트 방지(모바일).
  const SEMI_LIST_PAGE = 50;
  const [semiListLimit, setSemiListLimit] = useState(SEMI_LIST_PAGE);
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
    // 서버 저장분도 확인 — 로컬이 비어 있어도(새 기기·동기화 실패) 서버 반자동은
    // 지울 수 있어야 한다. 로컬·서버 모두 없을 때만 조기 종료.
    const serverSemiCount = accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines?.length ?? 0;
    if (savedTotalLines === 0 && bulkCount === 0 && serverSemiCount === 0) return;
    const parts: string[] = [];
    if (semiSlipQueue.length > 0) parts.push(`저장 ${semiSlipQueue.length}장`);
    if (semiCurrentLines.length > 0) parts.push(`입력 중 ${semiCurrentLines.length}줄`);
    if (bulkCount > 0) parts.push(`대량 ${bulkCount}장`);
    if (parts.length === 0 && serverSemiCount > 0) parts.push(`서버 저장 ${serverSemiCount}줄`);
    const ok = await confirm({
      message: `반자동 누적 (${parts.join(' + ')}) 을 서버·로컬에서 모두 삭제할까요? (자동 저장분은 유지)`,
      destructive: true,
      confirmText: '반자동만 삭제',
    });
    if (!ok) return;
    // 서버의 '반자동' 저장분만 삭제(자동 유지). 로컬 반자동 누적도 초기화.
    try {
      await v1Api.clearPhotoAnalysisStore(sheetIntent, '반자동');
    } catch (e) {
      setSaveNotice(e instanceof Error ? `반자동 서버 삭제 실패: ${e.message}` : '반자동 서버 삭제 실패');
      return;
    }
    setSemiCurrentLines([]);
    setSemiSlipQueue([]);
    setBulkTickets([]);
    setLastSavedAt(null);
    if (onRefreshAccumulated) {
      try { await onRefreshAccumulated(); } catch { /* 삭제는 완료됨 — 갱신 실패는 무시 */ }
    }
    setSaveNotice('반자동 누적(서버+로컬)이 모두 삭제되었습니다.');
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
    // ⛔ 회차 오염 방지 — 로컬 누적이 지난 회차 기준인데 그대로 저장하면 서버에
    // 현재 회차로 재라벨링된다(1232 용지가 복기 1233 으로 저장된 실제 사고).
    // 사용자가 의도를 밝히도록 확인을 받고, 취소 시 저장하지 않는다.
    if (staleLocalRound) {
      const ok = await confirm({
        message:
          `이 로컬 누적은 ${localRoundNo}회 기준으로 저장된 데이터입니다. ` +
          `지금 저장하면 ${effectiveRound}회 데이터로 기록되어 회차가 뒤섞입니다.\n\n` +
          `정말 ${effectiveRound}회 용지로 저장할까요? ` +
          `(${localRoundNo}회 데이터를 보존하려면 취소 후 [반자동 누적 전체 삭제] 로 정리하세요)`,
        destructive: true,
        confirmText: `${effectiveRound}회로 저장`,
      });
      if (!ok) {
        setSaveNotice(
          `↩ 저장을 취소했습니다. 이 누적은 ${localRoundNo}회 기준이며, 현재 탭은 ${effectiveRound}회입니다.`
        );
        return;
      }
    }
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
        pickType: '반자동',
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
        // 저장된 대상 회차를 stamp — 이후 회차가 넘어가면 재저장을 막는 기준.
        setLocalRoundNo(effectiveRound ?? null);
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
      // 저장 응답에 누적 미포함(경량화) — 저장 성공 후 별도 GET 으로 누적 갱신.
      qc.invalidateQueries({ queryKey: ['photo-analysis-accumulated'] });
      if (onRefreshAccumulated) {
        try { await onRefreshAccumulated(); } catch { /* 저장은 완료됨 — 갱신 실패는 무시 */ }
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setSaveNotice(
        `❌ 저장 실패: ${e instanceof Error ? e.message : '서버 오류'}. 데이터는 localStorage에 보존됩니다.`
      );
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, [
    semiSlipQueue,
    semiCurrentLines,
    bulkTickets,
    onAccumulatedChange,
    qc,
    sheetIntent,
    staleLocalRound,
    localRoundNo,
    effectiveRound,
    confirm,
    onRefreshAccumulated,
  ]);

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

  // 보류 중이면 교집합/요약도 잠시 쉰다. 해제 시에는 항상 전체 줄로 계산(샘플링 없음).
  const lightComparisonSuspended = suspendHeavyComparison;

  const bulkComparison = useMemo(
    () => {
      if (lightComparisonSuspended || bulkTickets.length === 0) return null;
      return buildBulkComparison(
        bulkTickets,
        slipQueue,
        accumulated,
        winningNumbers,
        winningBonus,
        sheetIntent,
        resolvedStrongCandidates
      );
    },
    [bulkTickets, slipQueue, accumulated, winningNumbers, winningBonus, sheetIntent, resolvedStrongCandidates, lightComparisonSuspended]
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
      return buildBulkComparison(
        combinedTickets,
        slipQueue,
        accumulated,
        winningNumbers,
        winningBonus,
        sheetIntent,
        resolvedStrongCandidates
      );
    },
    [combinedTickets, slipQueue, accumulated, winningNumbers, winningBonus, sheetIntent, resolvedStrongCandidates, lightComparisonSuspended]
  );

  /**
   * 대량 비교 결과 패널용 — 자동+반자동 통합 통계 (combinedComparison) 우선,
   * 없을 때만 bulkComparison 으로 폴백.
   */
  const activeComparison = combinedComparison ?? bulkComparison;

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
        allAutoNumbers: [] as number[][],
        allSemiNumbers: [] as number[][],
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
      // 중복 제거된 '모든' 자동·반자동 줄(번호 배열) — 매치 여부와 무관하게 각 번호가
      // 몇 줄에 나오는지(반복 출현 빈도)를 세기 위해 노출. 매치번호가 아니어도
      // 그 줄에 든 번호(예: {6,24} 매치 줄 안의 14)까지 모두 집계된다.
      allAutoNumbers: autoLines.map((l) => l.numbers),
      allSemiNumbers: semiLines.map((l) => l.numbers),
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

  // 🔒 반자동 고정수 감지 — crossSet/deep/predicted 공통. 줄≥10 · 등장≥50%.
  const fixedSemiNumbers = useMemo(() => {
    const lines = groupLineMatching.allSemiNumbers;
    const n = lines.length;
    if (n < 10) return { set: new Set<number>(), list: [] as { number: number; frac: number }[], lineCount: n };
    const freq: Record<number, number> = {};
    for (const line of lines) for (const v of new Set(line)) if (v >= 1 && v <= 45) freq[v] = (freq[v] ?? 0) + 1;
    const list = Object.entries(freq)
      .map(([v, c]) => ({ number: Number(v), frac: c / n }))
      .filter((x) => x.frac >= 0.5)
      .sort((a, b) => b.frac - a.frac || a.number - b.number);
    return { set: new Set(list.map((x) => x.number)), list, lineCount: n };
  }, [groupLineMatching.allSemiNumbers]);

  // 🔁 세트 중복 역산 — 모든 일치 그룹(6·5·4·3·2)의 matchedNumbers 를 서로 교차해,
  // 2·3개짜리 하위 세트가 '몇 개의 그룹에 걸쳐' 반복 등장하는지(groupCount)와 그
  // 지지(support=Σ(자동수+반자동수))를 집계한다. 예: {13,38} 이 2일치·3일치·5일치
  // 그룹 여러 곳에 나타나면 강한 반복 패턴. 자동·반자동이 반복해 함께 가리킨 세트를
  // 찾는 2차 전수비교다. 당첨번호는 정렬에 쓰지 않고(누수 방지) 표시만 대조한다.
  // 🔒 고정수 포함 세트는 제외(오염 방지).
  const crossSetPatterns = useMemo(() => {
    const fixedSet = fixedSemiNumbers.set;
    const allGroups = [
      ...groupLineMatching.groups6,
      ...groupLineMatching.groups5,
      ...groupLineMatching.groups4,
      ...groupLineMatching.groups3,
      ...groupLineMatching.groups2,
    ];
    type Acc = { numbers: number[]; groupCount: number; support: number; maxLevel: number };
    const pairMap = new Map<string, Acc>();
    const tripleMap = new Map<string, Acc>();
    const addCombo = (map: Map<string, Acc>, combo: number[], support: number, level: number) => {
      if (combo.some((n) => fixedSet.has(n))) return;
      const key = combo.join('-');
      const e = map.get(key);
      if (e) {
        e.groupCount += 1;
        e.support += support;
        e.maxLevel = Math.max(e.maxLevel, level);
      } else {
        map.set(key, { numbers: combo, groupCount: 1, support, maxLevel: level });
      }
    };
    for (const g of allGroups) {
      const nums = g.matchedNumbers.filter((n) => !fixedSet.has(n));
      const support = g.autoList.length + g.semiList.length;
      for (let i = 0; i < nums.length; i += 1) {
        for (let j = i + 1; j < nums.length; j += 1) {
          addCombo(pairMap, [nums[i], nums[j]], support, g.matchCount);
          for (let k = j + 1; k < nums.length; k += 1) {
            addCombo(tripleMap, [nums[i], nums[j], nums[k]], support, g.matchCount);
          }
        }
      }
    }
    const finalize = (map: Map<string, Acc>) =>
      Array.from(map.values())
        // 2개 이상 그룹에 걸쳐 반복 등장한 세트만(1회성 우연 제외).
        .filter((e) => e.groupCount >= 2)
        .map((e) => ({
          ...e,
          winning: winningSet != null && winningSet.size > 0 ? e.numbers.every((n) => winningSet.has(n)) : false,
          winHit: winningSet != null ? e.numbers.filter((n) => winningSet.has(n)).length : 0,
        }))
        .sort((a, b) => b.support - a.support || b.groupCount - a.groupCount)
        .slice(0, 15);
    return { pairs: finalize(pairMap), triples: finalize(tripleMap) };
  }, [
    groupLineMatching.groups6,
    groupLineMatching.groups5,
    groupLineMatching.groups4,
    groupLineMatching.groups3,
    groupLineMatching.groups2,
    winningSet,
    fixedSemiNumbers,
  ]);

  // 🎯 당첨 예상번호 & 번호별 반복 출현 정밀 프로파일 (단일 소스).
  // 핵심 신호 = 자동↔반자동 1:1 전수비교에서 '서로 다른 자동 줄 수 × 서로 다른
  // 반자동 줄 수'(distinct line — 같은 줄 중복 안 셈). 자동·반자동 '양쪽 모두'에서
  // 반복 출현할수록 강하고, 큰 매치(3+)에 든 번호는 보너스. 한쪽만 인기인 번호는
  // 곱(log×log)으로 자동 억제된다. 여기에 세트 중복(동반 반복)·평행회차를 더한다.
  // 당첨번호(winningSet)는 계산에 넣지 않는다(누수 방지) — 복기 탭은 대조만.
  // 🔒 반자동 고정수는 발견 신호에서 제외한다(fixedSemiNumbers, 아래 add 가드).
  const predictedNumbers = useMemo(() => {
    type Prof = {
      autoIdx: Set<number>;
      semiIdx: Set<number>;
      byLevel: Record<number, number>;
      maxMatch: number;
      partners: Record<number, number>;
    };
    const prof: Record<number, Prof> = {};
    const ens = (n: number): Prof =>
      (prof[n] ??= { autoIdx: new Set(), semiIdx: new Set(), byLevel: {}, maxMatch: 0, partners: {} });
    const groups = [
      ...groupLineMatching.groups6,
      ...groupLineMatching.groups5,
      ...groupLineMatching.groups4,
      ...groupLineMatching.groups3,
      ...groupLineMatching.groups2,
    ];
    for (const g of groups) {
      for (const n of g.matchedNumbers) {
        if (!Number.isInteger(n) || n < 1 || n > 45) continue;
        const p = ens(n);
        for (const a of g.autoList) p.autoIdx.add(a.idx);
        for (const s of g.semiList) p.semiIdx.add(s.idx);
        p.byLevel[g.matchCount] = (p.byLevel[g.matchCount] ?? 0) + 1;
        p.maxMatch = Math.max(p.maxMatch, g.matchCount);
        for (const m of g.matchedNumbers) if (m !== n) p.partners[m] = (p.partners[m] ?? 0) + 1;
      }
    }
    // 반복 출현 빈도 = '모든' 자동·반자동 줄에서 각 번호가 몇 줄에 나오는지(줄 단위
    // 중복 제거). 매치번호가 아니어도(예: {6,24} 매치 줄 안의 14) 그 줄에 있으면 센다.
    const autoFreq: Record<number, number> = {};
    const semiFreq: Record<number, number> = {};
    for (const line of groupLineMatching.allAutoNumbers)
      for (const n of new Set(line)) autoFreq[n] = (autoFreq[n] ?? 0) + 1;
    for (const line of groupLineMatching.allSemiNumbers)
      for (const n of new Set(line)) semiFreq[n] = (semiFreq[n] ?? 0) + 1;

    const score: Record<number, number> = {};
    const srcMap: Record<number, Set<string>> = {};
    const fixedSet = fixedSemiNumbers.set;
    const add = (n: number, w: number, src: string) => {
      if (!Number.isInteger(n) || n < 1 || n > 45 || w <= 0) return;
      if (fixedSet.has(n)) return; // 🔒 반자동 고정수는 발견 신호(강수/기대/예상)에서 제외 — 별도 패널 표시
      score[n] = (score[n] ?? 0) + w;
      (srcMap[n] ??= new Set<string>()).add(src);
    };
    // 자동·반자동 '양쪽 줄'에 반복 출현할수록 강함(곱). 큰 매치(3+)에 든 번호는 보너스.
    // 한쪽만 인기인 번호는 반대쪽 log=0 으로 자동 억제. 후보=어느 한쪽이라도 등장한 번호.
    const cand = new Set<number>([...Object.keys(autoFreq), ...Object.keys(semiFreq)].map(Number));
    for (const n of cand) {
      const a = autoFreq[n] ?? 0;
      const s = semiFreq[n] ?? 0;
      const mm = prof[n]?.maxMatch ?? 0;
      const w = Math.log2(a + 1) * Math.log2(s + 1) * (1 + 0.4 * Math.max(0, mm - 2)) * 4;
      add(n, w, '1:1');
    }
    // 세트 중복 역산 보너스 — 여러 그룹에 반복 등장한 강한 세트({13,38}) 가산.
    for (const st of [...crossSetPatterns.pairs, ...crossSetPatterns.triples]) {
      const bonus = Math.log2(st.support + 1) * Math.log2(st.groupCount + 1) * st.numbers.length * 2;
      for (const n of st.numbers) add(n, bonus, '세트');
    }
    // 평행회차 (보조) — 이번회차만. 복기에 넣으면 API 로드 후 1:1 순위가 뒤집혀
    // 강수·접목 recall 이 로딩 전보다 나빠지는 회귀(1235: 핵심 3/6→0/6)가 난다.
    if (!compareWinning) {
      parallelStrong.forEach((n, idx) => add(n, Math.max(2, 14 - idx * 0.8), '평행'));
      parallelExpected.forEach((n, idx) => add(n, Math.max(1, 7 - idx * 0.4), '평행'));
    }

    const ranked = Object.keys(score)
      .map(Number)
      .map((n) => {
        const p = prof[n];
        const partners = p
          ? Object.entries(p.partners)
              .sort((x, y) => y[1] - x[1])
              .slice(0, 3)
              .map(([m]) => Number(m))
          : [];
        const totalGroups = p ? Object.values(p.byLevel).reduce((x, y) => x + y, 0) : 0;
        return {
          number: n,
          score: score[n],
          sources: Array.from(srcMap[n] ?? []),
          maxMatch: p?.maxMatch ?? 0,
          auto: autoFreq[n] ?? 0,
          semi: semiFreq[n] ?? 0,
          byLevel: p?.byLevel ?? ({} as Record<number, number>),
          partners,
          totalGroups,
        };
      })
      .sort((a, b) => b.score - a.score || a.number - b.number);
    const maxScore = ranked[0]?.score ?? 1;
    return ranked.map((r) => ({ ...r, confidence: Math.round((r.score / maxScore) * 100) }));
  }, [
    groupLineMatching.groups6,
    groupLineMatching.groups5,
    groupLineMatching.groups4,
    groupLineMatching.groups3,
    groupLineMatching.groups2,
    groupLineMatching.allAutoNumbers,
    groupLineMatching.allSemiNumbers,
    parallelStrong,
    parallelExpected,
    crossSetPatterns,
    fixedSemiNumbers,
    compareWinning,
  ]);

  // crossValidation 은 L8 deepAnalysis 정의 이후에 연결(심층 composite 실제 사용).

  // ★ 1:1 강수·기대수 (구간별) — 평행회차 패널과 같은 레이아웃을 1:1 전수비교
  // 반복도(predictedNumbers 순위)로 생성. 강수=구간(단/10/20/30/40번대) 내 반복도
  // 상위 3, 기대수=다음 3. 끝수=끝자리별 양쪽(자동+반자동) 등장 줄 수 합.
  // 복기 탭은 당첨번호를 초록으로 대조(계산엔 미사용).
  const decadePattern = useMemo(() => {
    if (predictedNumbers.length === 0) return null;
    const bands = [
      { label: '단번대', lo: 1, hi: 9 },
      { label: '10번대', lo: 10, hi: 19 },
      { label: '20번대', lo: 20, hi: 29 },
      { label: '30번대', lo: 30, hi: 39 },
      { label: '40번대', lo: 40, hi: 45 },
    ];
    const isWin = (n: number) => (winningSet != null && winningSet.size > 0 ? winningSet.has(n) : false);
    // 미출수 — 자동·반자동 어느 줄에도 등장하지 않은 번호(양쪽 등장 0).
    // 티켓 기반 방법으론 절대 추출 불가한 영역 — 당첨이 여기서 나오면 그 회차는
    // 데이터로 못 잡는다는 정직한 지표가 된다.
    // ⚠️ 고정수는 predictedNumbers 에서 제외됐지만 반자동 줄엔 '등장' 하므로 미출이
    //    아니다 — presentSet 에 다시 포함해 미출로 오분류되지 않게 한다.
    const presentSet = new Set(predictedNumbers.filter((p) => p.auto + p.semi > 0).map((p) => p.number));
    for (const n of fixedSemiNumbers.set) presentSet.add(n);
    const byBand = bands.map((b) => {
      const inBand = predictedNumbers.filter((p) => p.number >= b.lo && p.number <= b.hi && p.auto + p.semi > 0);
      const mk = (p: (typeof predictedNumbers)[number]) => ({
        number: p.number,
        auto: p.auto,
        semi: p.semi,
        maxMatch: p.maxMatch,
        winning: isWin(p.number),
      });
      const missing: { number: number; winning: boolean }[] = [];
      for (let n = b.lo; n <= b.hi; n += 1) {
        if (!presentSet.has(n)) missing.push({ number: n, winning: isWin(n) });
      }
      return {
        label: b.label,
        strong: inBand.slice(0, 3).map(mk),
        expected: inBand.slice(3, 6).map(mk),
        missing,
      };
    });
    // 끝수 — 끝자리(0~9)별 양쪽 등장 줄 수 합(자동+반자동), 상위 5.
    const ending: Record<number, number> = {};
    for (const p of predictedNumbers) {
      const d = p.number % 10;
      ending[d] = (ending[d] ?? 0) + p.auto + p.semi;
    }
    const endingTop = Object.entries(ending)
      .map(([d, c]) => ({ digit: Number(d), count: c }))
      .sort((a, b) => b.count - a.count || a.digit - b.digit)
      .slice(0, 5);
    const allStrong = byBand.flatMap((b) => b.strong.map((s) => s.number));
    const allExpected = byBand.flatMap((b) => b.expected.map((s) => s.number));
    const allMissing = byBand.flatMap((b) => b.missing.map((m) => m.number));
    const strongWinHit = winningSet != null && winningSet.size > 0
      ? allStrong.filter((n) => winningSet.has(n)).length
      : null;
    // 강수/기대/그외/미출 당첨 분포 비교(복기) — 당첨이 어느 계층에서 나왔는지.
    const distribution = winningSet != null && winningSet.size > 0
      ? (() => {
          const strongSet = new Set(allStrong);
          const expectedSet = new Set(allExpected);
          const missingSet = new Set(allMissing);
          let s = 0; let e = 0; let m = 0; let etc = 0;
          for (const n of winningSet) {
            if (strongSet.has(n)) s += 1;
            else if (expectedSet.has(n)) e += 1;
            else if (missingSet.has(n)) m += 1;
            else etc += 1;
          }
          return { strong: s, expected: e, missing: m, etc };
        })()
      : null;
    return {
      byBand,
      endingTop,
      strongCount: allStrong.length,
      expectedCount: allExpected.length,
      missingCount: allMissing.length,
      strongWinHit,
      distribution,
    };
  }, [predictedNumbers, winningSet, fixedSemiNumbers]);

  // 🧬 당첨 패턴 학습 — 복기(1231) 서버 데이터로 '당첨번호가 1:1 데이터에서 갖던
  // 프로파일'(반복도 백분위·자동/반자동 등장 비율·3+일치 여부)을 통계화한다.
  // 복기 슬라이스는 양 탭에서 접근 가능하므로 이번회차 탭에서도 같은 학습값을 쓴다.
  const learnedPattern = useMemo(() => {
    const rev = accumulated?.by_intent?.review;
    const autoL = (rev?.saved_auto_lines ?? []).map((l) => l.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45));
    const semiL = (rev?.saved_semi_lines ?? []).map((l) => l.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45));
    const winNums = (rev?.draw_template?.winning_numbers ?? []).filter((n) => n >= 1 && n <= 45);
    const round = rev?.draw_template?.ticket_round ?? rev?.ticket_round ?? null;
    if (autoL.length < 5 || semiL.length < 5 || winNums.length !== 6) return null;
    if (autoL.length * semiL.length > 250_000) return null; // 모바일 안전 상한
    const af: Record<number, number> = {};
    const sf: Record<number, number> = {};
    for (const l of autoL) for (const n of new Set(l)) af[n] = (af[n] ?? 0) + 1;
    for (const l of semiL) for (const n of new Set(l)) sf[n] = (sf[n] ?? 0) + 1;
    // 3+일치 여부 — 복기 데이터의 자동×반자동 페어 전수 매칭.
    const mm: Record<number, number> = {};
    const semiSets = semiL.map((l) => new Set(l));
    for (const a of autoL) {
      const aset = new Set(a);
      for (const s of semiSets) {
        let cnt = 0;
        const matched: number[] = [];
        for (const n of s) if (aset.has(n)) { cnt += 1; matched.push(n); }
        if (cnt >= 2) for (const n of matched) mm[n] = Math.max(mm[n] ?? 0, cnt);
      }
    }
    const nums = Array.from(new Set([...Object.keys(af), ...Object.keys(sf)].map(Number)));
    const score = (n: number) => Math.log2((af[n] ?? 0) + 1) * Math.log2((sf[n] ?? 0) + 1);
    const ranked = [...nums].sort((a, b) => score(b) - score(a) || a - b);
    const pct: Record<number, number> = {};
    ranked.forEach((n, i) => { pct[n] = ranked.length > 1 ? 1 - i / (ranked.length - 1) : 1; });
    const feats = winNums.map((n) => ({
      number: n,
      pct: pct[n] ?? 0,
      aShare: (af[n] ?? 0) / autoL.length,
      sShare: (sf[n] ?? 0) / semiL.length,
      deep: (mm[n] ?? 0) >= 3 ? 1 : 0,
      rank: ranked.indexOf(n) + 1 || null,
    }));
    const mean = (k: 'pct' | 'aShare' | 'sShare' | 'deep') => feats.reduce((s, f) => s + f[k], 0) / feats.length;
    const centroid = { pct: mean('pct'), aShare: mean('aShare'), sShare: mean('sShare'), deep: mean('deep') };
    // 당첨 '조합' 구조 학습 — 합계·홀수 개수·구간(10단위) 분산·최장 연속.
    // 번호 단위 프로파일과 별개로 6개 묶음의 형태를 통계화해 추천 조합 스코어에 전이.
    const sorted = [...winNums].sort((a, b) => a - b);
    let maxConsec = 1;
    let run = 1;
    for (let i = 1; i < sorted.length; i += 1) {
      run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
      maxConsec = Math.max(maxConsec, run);
    }
    const structure = {
      sum: sorted.reduce((s, n) => s + n, 0),
      odd: sorted.filter((n) => n % 2 === 1).length,
      decades: new Set(sorted.map((n) => Math.min(4, Math.floor((n - 1) / 10)))).size,
      consec: maxConsec,
    };
    return { round, centroid, feats, structure, totalNums: ranked.length, autoCount: autoL.length, semiCount: semiL.length };
  }, [accumulated]);

  // 🧬 프로파일 매칭 예상 — 현재 탭의 각 번호 프로파일이 '학습된 1231 당첨 프로파일'
  // 과 얼마나 가까운지(거리 역수)로 정렬. 복기 탭=적합도 자기확인(같은 회차 학습이라
  // 낙관적), 이번회차 탭=학습 전이 예측(1232). 당첨번호는 현재 탭 계산에 미사용.
  const patternMatched = useMemo(() => {
    if (!learnedPattern || predictedNumbers.length === 0) return null;
    // 현재 탭에 1:1 데이터(자동·반자동 줄)가 없으면 프로파일 비교 자체가 무의미 —
    // A/S 를 1로 클램프하면 평행회차-단독 번호에 오해적 유사도가 붙는다 → 표시 안 함.
    if (groupLineMatching.autoLineCount === 0 || groupLineMatching.semiLineCount === 0) return null;
    const A = Math.max(1, groupLineMatching.autoLineCount);
    const S = Math.max(1, groupLineMatching.semiLineCount);
    const c = learnedPattern.centroid;
    const list = predictedNumbers
      .map((p, i) => {
        const pctRank = predictedNumbers.length > 1 ? 1 - i / (predictedNumbers.length - 1) : 1;
        const dist =
          Math.abs(pctRank - c.pct) * 1.5 +
          Math.abs(p.auto / A - c.aShare) * 2 +
          Math.abs(p.semi / S - c.sShare) * 2 +
          Math.abs((p.maxMatch >= 3 ? 1 : 0) - c.deep) * 0.5;
        return {
          number: p.number,
          sim: Math.round((1 / (1 + dist * 4)) * 100),
          deep: p.maxMatch >= 3,
          winning: winningSet != null && winningSet.size > 0 ? winningSet.has(p.number) : false,
        };
      })
      .sort((a, b) => b.sim - a.sim || a.number - b.number)
      .slice(0, 10);
    const hit = compareWinning && winningSet && winningSet.size > 0
      ? list.slice(0, 6).filter((x) => x.winning).length
      : null;
    return { list, hit };
  }, [learnedPattern, predictedNumbers, groupLineMatching.autoLineCount, groupLineMatching.semiLineCount, winningSet, compareWinning]);

  // 전수비교 '강한 패턴' — matchCount 3+ 그룹(우연 초과의 실제 겹침)을 크기·지지순.
  // 정렬은 '당첨 무관'(matchCount·지지) — 당첨 여부로 정렬하면 사후에 당첨을 끌어올려
  // 착시가 생긴다. 복기 탭은 초록으로 '대조'만 하고 순서엔 영향 주지 않는다.
  const topPatterns = useMemo(() => {
    const list = [
      ...groupLineMatching.groups6,
      ...groupLineMatching.groups5,
      ...groupLineMatching.groups4,
      ...groupLineMatching.groups3,
    ]
      .map((g) => ({
        matchCount: g.matchCount,
        numbers: g.matchedNumbers,
        autoCount: g.autoList.length,
        semiCount: g.semiList.length,
        support: g.autoList.length + g.semiList.length,
        allWinning:
          winningSet != null && winningSet.size > 0
            ? g.matchedNumbers.every((n) => winningSet.has(n))
            : false,
        winHit: winningSet != null ? g.matchedNumbers.filter((n) => winningSet.has(n)).length : 0,
      }))
      .sort((a, b) => b.matchCount - a.matchCount || b.support - a.support);
    return list.slice(0, 20);
  }, [
    groupLineMatching.groups6,
    groupLineMatching.groups5,
    groupLineMatching.groups4,
    groupLineMatching.groups3,
    winningSet,
  ]);

  // 📌 당첨번호 출현 패턴 (복기 전용, 당첨번호 사용) — 실제 당첨번호가 전수비교에서
  // '어느 레벨에 얼마나 반복' 나왔고, 순수 반복도(당첨 무관) 전체 순위 몇 위였는지 역산.
  // 목적: 복기(당첨 이미 있음)에서 '반복도 방식이 당첨을 얼마나 포착했는지' 를 눈으로
  // 확인 → 그 근거로 다음 회차(1232) 예상번호(반복도 상위)를 쓴다. predictedNumbers
  // (순수 반복도 전체 정렬)를 그대로 재사용해 당첨번호의 순위·프로파일을 뽑는다.
  const winningPatternAnalysis = useMemo(() => {
    if (!compareWinning || winningSet == null || winningSet.size === 0) return null;
    const rankByNum = new Map(predictedNumbers.map((p, i) => [p.number, { ...p, rank: i + 1 }]));
    const winNums = Array.from(winningSet).sort((a, b) => a - b);
    const perWinning = winNums
      .map((n) => {
        const e = rankByNum.get(n);
        return e
          ? { number: n, appeared: true, rank: e.rank, totalGroups: e.totalGroups, byLevel: e.byLevel, auto: e.auto, semi: e.semi }
          : { number: n, appeared: false, rank: null as number | null, totalGroups: 0, byLevel: {} as Record<number, number>, auto: 0, semi: 0 };
      })
      .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    const winByLevel: Record<number, number> = {};
    for (const w of perWinning)
      for (const [L, c] of Object.entries(w.byLevel)) winByLevel[Number(L)] = (winByLevel[Number(L)] ?? 0) + c;
    const dominantLevel = Object.entries(winByLevel).sort((a, b) => b[1] - a[1])[0] ?? null;
    const ranks = perWinning.map((w) => w.rank).filter((r): r is number => r != null);
    return {
      perWinning,
      dominantLevel,
      winPairs: crossSetPatterns.pairs.filter((s) => s.winning),
      winTriples: crossSetPatterns.triples.filter((s) => s.winning),
      inTop8: ranks.filter((r) => r <= 8).length,
      inTop14: ranks.filter((r) => r <= 14).length,
      appearedCount: perWinning.filter((w) => w.appeared).length,
      totalWin: winNums.length,
      totalNumbers: predictedNumbers.length,
    };
  }, [compareWinning, winningSet, predictedNumbers, crossSetPatterns]);

  // 일치 개수별(6/5/4/3/2) 겹침 번호 역산 — 각 레벨에서 어떤 번호가 반복해 겹쳐
  // 나왔는지(groupCount)와 양쪽 지지(support=Σ min(자동수,반자동수))로 정렬.
  // 복기 탭은 각 레벨에서 실제 당첨번호가 몇 개 나왔는지 함께 표시(당첨 패턴 확인).
  const levelBreakdown = useMemo(() => {
    const levels = [
      { mc: 6, groups: groupLineMatching.groups6 },
      { mc: 5, groups: groupLineMatching.groups5 },
      { mc: 4, groups: groupLineMatching.groups4 },
      { mc: 3, groups: groupLineMatching.groups3 },
      { mc: 2, groups: groupLineMatching.groups2 },
    ];
    return levels
      .map(({ mc, groups }) => {
        const freq: Record<number, number> = {};
        const support: Record<number, number> = {};
        for (const g of groups) {
          const s = Math.min(g.autoList.length, g.semiList.length);
          for (const n of g.matchedNumbers) {
            freq[n] = (freq[n] ?? 0) + 1;
            support[n] = (support[n] ?? 0) + s;
          }
        }
        const numbers = Object.keys(freq)
          .map(Number)
          .map((n) => ({
            number: n,
            groupCount: freq[n],
            support: support[n],
            winning: winningSet != null && winningSet.size > 0 ? winningSet.has(n) : false,
          }))
          .sort(
            (a, b) => b.support - a.support || b.groupCount - a.groupCount || a.number - b.number,
          );
        const winHits = numbers.filter((x) => x.winning).length;
        return { mc, groupCount: groups.length, numbers, winHits };
      })
      .filter((lv) => lv.groupCount > 0);
  }, [
    groupLineMatching.groups6,
    groupLineMatching.groups5,
    groupLineMatching.groups4,
    groupLineMatching.groups3,
    groupLineMatching.groups2,
    winningSet,
  ]);

  // 🧠 심층 역산 분석 — 빈도·일치개수 가중치·자동반자동 교집합·세트반복·허브(응집도)·
  // 네트워크 중심성·숨은 강수·종합 핵심을 한 번에 계산한다. 단순 빈도가 아니라 '번호
  // 간 연결성'으로 당첨 구조를 역산한다. 당첨(winningSet)은 계산에 안 쓰고 대조만.
  const deepAnalysis = useMemo(() => {
    const groups = [
      ...groupLineMatching.groups6,
      ...groupLineMatching.groups5,
      ...groupLineMatching.groups4,
      ...groupLineMatching.groups3,
      ...groupLineMatching.groups2,
    ];
    const auto = groupLineMatching.allAutoNumbers;
    const semi = groupLineMatching.allSemiNumbers;
    // 심층 역산은 자동↔반자동 '교차' 분석이다. 한쪽이라도 비면 consensus=
    // log2(af+1)*log2(sf+1) 가 전 번호 0 이 되어 composite/finalPick 이 번호
    // 오름차순(무의미)으로 붕괴한다 → 오해를 부르는 조합 대신 섹션을 숨긴다.
    if (auto.length === 0 || semi.length === 0) return null;
    const LW: Record<number, number> = { 6: 10, 5: 8, 4: 6, 3: 4, 2: 2 };
    const win = (n: number) => (winningSet != null && winningSet.size > 0 ? winningSet.has(n) : false);

    // (1) 등장 빈도 — 자동/반자동/전체 (줄 단위 distinct). 반자동 고정수는 0 처리.
    const fixedSet = fixedSemiNumbers.set;
    const af: Record<number, number> = {};
    const sf: Record<number, number> = {};
    for (const l of auto) for (const n of new Set(l)) if (n >= 1 && n <= 45) af[n] = (af[n] ?? 0) + 1;
    for (const l of semi) for (const n of new Set(l)) {
      if (n >= 1 && n <= 45 && !fixedSet.has(n)) sf[n] = (sf[n] ?? 0) + 1;
    }

    // (2) 일치개수 가중치 점수 + (5/6) 공출현 네트워크(허브/중심성)
    const wscore: Record<number, number> = {};
    const maxMatch: Record<number, number> = {};
    const grpCnt: Record<number, number> = {};
    const deg: Record<number, number> = {};
    const partners: Record<number, Record<number, number>> = {};
    for (const g of groups) {
      const gw = (LW[g.matchCount] ?? 1) * (1 + Math.log2(Math.min(g.autoList.length, g.semiList.length) + 1));
      for (const n of g.matchedNumbers) {
        if (fixedSet.has(n)) continue;
        wscore[n] = (wscore[n] ?? 0) + gw;
        maxMatch[n] = Math.max(maxMatch[n] ?? 0, g.matchCount);
        grpCnt[n] = (grpCnt[n] ?? 0) + 1;
      }
      const ns = g.matchedNumbers.filter((n) => !fixedSet.has(n));
      for (let i = 0; i < ns.length; i += 1)
        for (let j = i + 1; j < ns.length; j += 1) {
          const a = ns[i];
          const b = ns[j];
          deg[a] = (deg[a] ?? 0) + gw;
          deg[b] = (deg[b] ?? 0) + gw;
          (partners[a] ??= {})[b] = (partners[a][b] ?? 0) + gw;
          (partners[b] ??= {})[a] = (partners[b][a] ?? 0) + gw;
        }
    }

    const freqTable = Array.from(new Set([...Object.keys(af), ...Object.keys(sf)].map(Number)))
      .map((n) => ({ number: n, auto: af[n] ?? 0, semi: sf[n] ?? 0, total: (af[n] ?? 0) + (sf[n] ?? 0), winning: win(n) }))
      .sort((a, b) => b.total - a.total || a.number - b.number);
    const weightedRank = Object.keys(wscore).map(Number)
      .map((n) => ({ number: n, wscore: Math.round(wscore[n]), maxMatch: maxMatch[n] ?? 0, groups: grpCnt[n] ?? 0, winning: win(n) }))
      .sort((a, b) => b.wscore - a.wscore || a.number - b.number);
    const hubRank = Object.keys(deg).map(Number)
      .map((n) => {
        const ps = Object.entries(partners[n] ?? {}).sort((x, y) => y[1] - x[1]);
        return { number: n, degree: Math.round(deg[n]), links: ps.length, topPartners: ps.slice(0, 4).map(([m]) => Number(m)), winning: win(n) };
      })
      .sort((a, b) => b.degree - a.degree || a.number - b.number);

    // (3) 자동·반자동 교집합 분류 (각 사이드 상위 12위 기준)
    const autoTop = new Set(Object.entries(af).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => Number(n)));
    const semiTop = new Set(Object.entries(sf).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => Number(n)));
    const both = [...autoTop].filter((n) => semiTop.has(n)).sort((a, b) => (af[b] + sf[b]) - (af[a] + sf[a]));
    const autoOnly = [...autoTop].filter((n) => !semiTop.has(n)).sort((a, b) => af[b] - af[a]);
    const semiOnly = [...semiTop].filter((n) => !autoTop.has(n)).sort((a, b) => sf[b] - sf[a]);

    // (4) 4번호 세트 반복
    const quad = new Map<string, { numbers: number[]; groupCount: number; support: number; winning: boolean }>();
    for (const g of groups) if (g.matchCount >= 4) {
      const ns2 = g.matchedNumbers;
      const supp = g.autoList.length + g.semiList.length;
      for (let i = 0; i < ns2.length; i += 1)
        for (let j = i + 1; j < ns2.length; j += 1)
          for (let k = j + 1; k < ns2.length; k += 1)
            for (let l = k + 1; l < ns2.length; l += 1) {
              const combo = [ns2[i], ns2[j], ns2[k], ns2[l]];
              const key = combo.join('-');
              const e = quad.get(key);
              if (e) { e.groupCount += 1; e.support += supp; }
              else quad.set(key, { numbers: combo, groupCount: 1, support: supp, winning: combo.every(win) });
            }
    }
    const sets4 = Array.from(quad.values()).sort((a, b) => b.support - a.support || b.groupCount - a.groupCount).slice(0, 6);

    // (7) 숨은 강수 — 총 등장은 중앙값 이하지만 큰 매치(4+)에서만 반복
    const totalsArr = freqTable.map((f) => f.total).sort((a, b) => a - b);
    const medianTotal = totalsArr[Math.floor(totalsArr.length / 2)] ?? 0;
    const hidden = weightedRank.filter((x) => x.maxMatch >= 4 && ((af[x.number] ?? 0) + (sf[x.number] ?? 0)) <= medianTotal).slice(0, 8);

    // (8/10) 종합 핵심 — 4개 '1:1 전수비교' 신호를 정규화(0~1) 선형 합성한 앙상블(아래
    // 참고: 순위합산 borda 는 롤백됨). 스케일이 다른 신호를 공정하게 합치고, 여러 신호에서
    // '고루 상위'인 번호(견고한 합의)를 최상위로 올린다. 1:1 이 가장 중요 → 양쪽빈도·가중치 최우선.
    const setSupport: Record<number, number> = {};
    for (const s of [...crossSetPatterns.pairs, ...crossSetPatterns.triples])
      for (const n of s.numbers) {
        if (fixedSet.has(n)) continue;
        setSupport[n] = (setSupport[n] ?? 0) + s.support;
      }
    const consensus: Record<number, number> = {};
    for (const n of freqTable.map((f) => f.number)) consensus[n] = Math.log2((af[n] ?? 0) + 1) * Math.log2((sf[n] ?? 0) + 1);
    const ensembleNums = Array.from(new Set([
      ...Object.keys(consensus),
      ...Object.keys(wscore),
      ...Object.keys(deg),
      ...Object.keys(setSupport),
    ].map(Number)));
    // 정규화(0~1) 선형 합성 — 순위합산(borda)은 {6,24} 처럼 '양쪽 다 강하지만 비당첨'인
    // 번호를 과대평가해 검증에서 오히려 나빴다. 크기(magnitude) 기반 선형이 강한 합의를
    // 더 잘 보존. 가중: 양쪽빈도 0.50(1:1 최우선)+가중치 0.30+세트 0.10+허브 0.10.
    const norm = (rec: Record<number, number>) => {
      const mx = Math.max(1, ...ensembleNums.map((n) => rec[n] ?? 0));
      return (n: number) => (rec[n] ?? 0) / mx;
    };
    const nC = norm(consensus);
    const nW = norm(wscore);
    const nD = norm(deg);
    const nS = norm(setSupport);
    const composite = ensembleNums
      .filter((n) => !fixedSet.has(n))
      .map((n) => ({
        number: n,
        score: Math.round((nC(n) * 0.5 + nW(n) * 0.3 + nS(n) * 0.1 + nD(n) * 0.1) * 1000),
        cFreq: Math.round(nC(n) * 100),
        cWeight: Math.round(nW(n) * 100),
        cSet: Math.round(nS(n) * 100),
        cHub: Math.round(nD(n) * 100),
        winning: win(n),
        auto: af[n] ?? 0,
        semi: sf[n] ?? 0,
        maxMatch: maxMatch[n] ?? 0,
        hub: Math.round(deg[n] ?? 0),
      }))
      .sort((a, b) => b.score - a.score || a.number - b.number);

    // ⑧ 최종 예측 조합 — composite 상위에서 '구간(10단위) 최대 2개' 로 균형 잡아 6개.
    const decadeOf = (n: number) => Math.min(4, Math.floor((n - 1) / 10));
    const finalPick: number[] = [];
    const decCnt: Record<number, number> = {};
    for (const c of composite) {
      if (finalPick.length >= 6) break;
      const d = decadeOf(c.number);
      if ((decCnt[d] ?? 0) >= 2) continue;
      finalPick.push(c.number);
      decCnt[d] = (decCnt[d] ?? 0) + 1;
    }
    for (const c of composite) {
      if (finalPick.length >= 6) break;
      if (!finalPick.includes(c.number)) finalPick.push(c.number);
    }
    finalPick.sort((a, b) => a - b);
    const reserve = composite.map((c) => c.number).filter((n) => !finalPick.includes(n)).slice(0, 3);
    const finalWin = winningSet != null && winningSet.size > 0 ? finalPick.filter((n) => winningSet.has(n)).length : null;

    // ⑨ 제외 후보 — 한쪽만 강한(양쪽 합의 약함) 번호.
    const exclude = [
      ...autoOnly.slice(0, 3).map((n) => ({ number: n, side: '자동만', winning: win(n) })),
      ...semiOnly.slice(0, 3).map((n) => ({ number: n, side: '반자동만', winning: win(n) })),
    ];

    // 구간 분산 (TOP15 이 1~45 구간에 어떻게 퍼졌나) — 조합 균형 참고.
    const decadeDist = [0, 1, 2, 3, 4].map((d) => ({
      label: d < 4 ? `${d * 10 + 1}-${d * 10 + 10}` : '41-45',
      count: composite.slice(0, 15).filter((c) => decadeOf(c.number) === d).length,
    }));

    const winCheck = winningSet != null && winningSet.size > 0
      ? { top6: composite.slice(0, 6).filter((c) => c.winning).length, top15: composite.slice(0, 15).filter((c) => c.winning).length }
      : null;

    // (A) 유의성 backtest (복기 전용) — 각 랭킹의 TOP-K 가 실제 당첨을 '우연 이상'으로
    // 담았는지 초기하분포(hypergeometric)로 p값 계산. p<0.05 면 우연 대비 유의.
    const backtest = winningSet != null && winningSet.size > 0
      ? (() => {
          const W = winningSet.size;
          const comb = (n: number, r: number): number => {
            if (r < 0 || r > n) return 0;
            const rr = Math.min(r, n - r);
            let c = 1;
            for (let i = 0; i < rr; i += 1) c = (c * (n - i)) / (i + 1);
            return c;
          };
          const pAtLeast = (k: number, K: number): number => {
            const denom = comb(45, K);
            if (denom === 0) return 1;
            let p = 0;
            for (let x = k; x <= Math.min(W, K); x += 1) p += (comb(W, x) * comb(45 - W, K - x)) / denom;
            return Math.min(1, Math.max(0, p));
          };
          const evalK = (ranked: number[], K: number) => {
            // 후보 풀이 K 보다 작으면 실제 예측 개수(kEff)로 기대값·p값을 계산해야
            // 한다. K 를 그대로 쓰면 희소 데이터에서 exp 과대·p값이 틀린 추첨크기로
            // 산출된다(예: 10개뿐인데 TOP15 로 계산). 충분하면 kEff===K 라 무변화.
            const picks = ranked.slice(0, K);
            const kEff = picks.length;
            const hit = picks.filter((n) => winningSet.has(n)).length;
            const exp = (W * kEff) / 45;
            return { K: kEff, hit, exp: Math.round(exp * 100) / 100, lift: exp > 0 ? Math.round((hit / exp) * 100) / 100 : 0, p: Math.round(pAtLeast(hit, kEff) * 1000) / 1000 };
          };
          const methods: { key: string; ranked: number[] }[] = [
            { key: '종합', ranked: composite.map((c) => c.number) },
            { key: '가중치', ranked: weightedRank.map((w) => w.number) },
            { key: '허브', ranked: hubRank.map((h) => h.number) },
            { key: '빈도', ranked: freqTable.map((f) => f.number) },
          ];
          return { W, methods: methods.map((m) => ({ key: m.key, k6: evalK(m.ranked, 6), k15: evalK(m.ranked, 15) })) };
        })()
      : null;

    // (B) 안정성 backtest (양 탭) — 티켓을 짝/홀 줄로 갈라 각 절반의 양쪽합의 TOP12 가
    // 얼마나 겹치나(Jaccard). 높으면 패턴이 견고, 낮으면 표본 노이즈(예측력 약함).
    const stability = (() => {
      const halfFreq = (lines: number[][], parity: number) => {
        const f: Record<number, number> = {};
        lines.forEach((l, i) => {
          if (i % 2 === parity) for (const n of new Set(l)) if (n >= 1 && n <= 45) f[n] = (f[n] ?? 0) + 1;
        });
        return f;
      };
      const topK = (afh: Record<number, number>, sfh: Record<number, number>, K: number) => {
        const cons: Record<number, number> = {};
        for (const n of new Set([...Object.keys(afh), ...Object.keys(sfh)].map(Number)))
          cons[n] = Math.log2((afh[n] ?? 0) + 1) * Math.log2((sfh[n] ?? 0) + 1);
        return new Set(Object.entries(cons).sort((a, b) => b[1] - a[1]).slice(0, K).map(([n]) => Number(n)));
      };
      const A = topK(halfFreq(auto, 0), halfFreq(semi, 0), 12);
      const B = topK(halfFreq(auto, 1), halfFreq(semi, 1), 12);
      if (A.size === 0 || B.size === 0) return null;
      const inter = [...A].filter((n) => B.has(n)).length;
      const uni = new Set([...A, ...B]).size;
      return { overlap: inter, jaccard: uni > 0 ? Math.round((inter / uni) * 100) : 0 };
    })();

    // 🔬 번호 추출 역산 — 대상(복기=실제 당첨, 이번회차=예상 상위6)이 각 1:1 신호에서
    // '몇 위'였는지 역산해, 그 번호가 데이터에서 어떻게(어느 신호로) 추출될 수 있었는지
    // 보여준다. 복기: "1231 당첨이 추출 가능했나". 이번회차: "예상번호의 추출 근거".
    const rankMapOf = (arr: number[]) => {
      const m: Record<number, number> = {};
      arr.forEach((n, i) => { m[n] = i + 1; });
      return m;
    };
    const rFreq = rankMapOf([...ensembleNums].sort((a, b) => (consensus[b] ?? 0) - (consensus[a] ?? 0) || a - b));
    const rWeight = rankMapOf([...ensembleNums].sort((a, b) => (wscore[b] ?? 0) - (wscore[a] ?? 0) || a - b));
    const rHub = rankMapOf([...ensembleNums].sort((a, b) => (deg[b] ?? 0) - (deg[a] ?? 0) || a - b));
    const rSet = rankMapOf([...ensembleNums].sort((a, b) => (setSupport[b] ?? 0) - (setSupport[a] ?? 0) || a - b));
    const rComp = rankMapOf(composite.map((c) => c.number));
    const isReviewTarget = winningSet != null && winningSet.size > 0;
    const targetNumbers = isReviewTarget
      ? Array.from(winningSet).sort((a, b) => a - b)
      : finalPick.slice();
    const extraction = targetNumbers.map((n) => {
      const present = rFreq[n] != null;
      const rk = { freq: rFreq[n] ?? null, weight: rWeight[n] ?? null, hub: rHub[n] ?? null, set: rSet[n] ?? null, comp: rComp[n] ?? null };
      const cands = [
        { k: '양쪽빈도', r: rk.freq },
        { k: '가중치', r: rk.weight },
        { k: '허브', r: rk.hub },
        { k: '세트', r: rk.set },
      ].filter((x) => x.r != null) as { k: string; r: number }[];
      const bestObj = cands.length ? cands.reduce((a, b) => (b.r < a.r ? b : a)) : null;
      return {
        number: n,
        present,
        ranks: rk,
        best: bestObj?.r ?? null,
        bestSignal: bestObj?.k ?? '없음',
        extractable: present && (bestObj?.r ?? 999) <= 15,
      };
    });
    const extractSummary = {
      total: targetNumbers.length,
      present: extraction.filter((e) => e.present).length,
      extractable: extraction.filter((e) => e.extractable).length,
      inCompTop15: extraction.filter((e) => (e.ranks.comp ?? 999) <= 15).length,
      inCompTop6: extraction.filter((e) => (e.ranks.comp ?? 999) <= 6).length,
    };

    return { freqTable, weightedRank, hubRank, both, autoOnly, semiOnly, sets4, hidden, composite, winCheck, backtest, stability, finalPick, reserve, finalWin, exclude, decadeDist, extraction, extractSummary, isReviewTarget };
  }, [
    groupLineMatching.groups6,
    groupLineMatching.groups5,
    groupLineMatching.groups4,
    groupLineMatching.groups3,
    groupLineMatching.groups2,
    groupLineMatching.allAutoNumbers,
    groupLineMatching.allSemiNumbers,
    crossSetPatterns,
    winningSet,
    fixedSemiNumbers,
  ]);


  // L8 → 점수 경로 연결: composite TOP을 deep 소스로 주입 (L1-B·③·최종강수).
  // 이번회차만 — 복기 탭 deep 주입은 같은 회차 용지로 점수를 끌어올리는 순환.
  // fixed_semi 는 composite 단계에서 이미 제외됨.
  const deepInjectSignals = useMemo((): ValidatedLearningSignal[] => {
    if (sheetIntent !== 'current_round') return [];
    const comp = deepAnalysis?.composite ?? [];
    if (!comp.length) return [];
    const maxScore = Math.max(1, comp[0]?.score ?? 1);
    return comp.slice(0, 15).map((c) => ({
      number: c.number,
      weight: Math.max(0.25, Math.min(1, c.score / maxScore)),
      source: 'deep' as const,
      label: '심층역산',
    }));
  }, [deepAnalysis, sheetIntent]);

  const sheetLearningSignals = useMemo(
    () => [...validatedLearning, ...deepInjectSignals],
    [validatedLearning, deepInjectSignals]
  );

  // 🔗 전수비교 × L8 심층 교차 검증 — deepAnalysis.composite 를 실제 deep 축으로 사용
  const crossValidation = useMemo(() => {
    if (predictedNumbers.length === 0) return null;
    const maxAuto = Math.max(1, ...predictedNumbers.map((p) => p.auto));
    const maxSemi = Math.max(1, ...predictedNumbers.map((p) => p.semi));
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const deepMax = Math.max(1, ...(deepAnalysis?.composite ?? []).map((c) => c.score));
    const deepByNum = new Map((deepAnalysis?.composite ?? []).map((c) => [c.number, c.score / deepMax]));
    const byNumber = new Map<number, (typeof predictedNumbers)[number]>();
    for (const p of predictedNumbers) {
      if (!byNumber.has(p.number)) byNumber.set(p.number, p);
    }
    const scored = Array.from(byNumber.values())
      .map((p) => {
        const oneToOne = p.auto > 0 && p.semi > 0;
        const support = oneToOne ? Math.sqrt((p.auto / maxAuto) * (p.semi / maxSemi)) : 0;
        // L8 composite 우선, 없으면 반복도 confidence 폴백
        const deep = deepByNum.get(p.number) ?? p.confidence / 100;
        const val = sheetLearningSignals.find((v) => v.number === p.number && v.source !== 'deep');
        const valBoost = val ? 0.08 * val.weight : 0;
        const cross = oneToOne
          ? (0.5 * deep + 0.5 * support) * (1 + 0.15 * Math.max(0, p.maxMatch - 2)) + valBoost
          : 0;
        return {
          number: p.number,
          auto: p.auto,
          semi: p.semi,
          maxMatch: p.maxMatch,
          sources: [
            ...p.sources,
            ...(deepByNum.has(p.number) ? ['심층'] : []),
            ...(val ? [val.label] : []),
          ],
          deep: Math.round(deep * 100),
          support: r2(support),
          cross: r2(cross),
          won: compareWinning && winningSet ? winningSet.has(p.number) : null,
          validated: Boolean(val),
        };
      })
      .filter((x) => x.cross > 0)
      .sort((a, b) => b.cross - a.cross || a.number - b.number);

    const backtest =
      compareWinning && winningSet && winningSet.size > 0
        ? {
            W: winningSet.size,
            top6Hits: scored.slice(0, 6).filter((x) => x.won).length,
            top10Hits: scored.slice(0, 10).filter((x) => x.won).length,
            exp6: Math.round(((6 * 6) / 45) * 100) / 100,
            exp10: Math.round(((10 * 6) / 45) * 100) / 100,
          }
        : null;

    return { scored: scored.slice(0, 12), total: scored.length, backtest };
  }, [predictedNumbers, winningSet, compareWinning, sheetLearningSignals, deepAnalysis]);

  // 🎯 이번회차 종합 예측 대시보드 (이번회차 탭 전용) — 이번회차에서 사용 가능한
  // 모든 신호를 하나로 종합한다: ①용지 교차검증(티켓 기반) ②통합 예측신호(6소스)
  // ③평행회차 강수/기대. 티켓이 없어도 ②③로 예측이 나오고, 티켓을 올리면 ①이
  // 주 신호로 가세한다. 번호별 기여 신호(출처)와 대표조합·분산 최적 대안을 노출.
  const currentRoundForecast = useMemo(() => {
    if (compareWinning) return null; // 복기(추첨완료) 탭에는 표시하지 않음
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const score: Record<number, number> = {};
    const srcMap: Record<number, Set<string>> = {};
    const add = (n: number, w: number, s: string) => {
      if (!Number.isInteger(n) || n < 1 || n > 45 || w <= 0) return;
      score[n] = (score[n] ?? 0) + w;
      (srcMap[n] ??= new Set<string>()).add(s);
    };
    // ① 용지 교차검증(자동↔반자동 1:1 × 심층역산) — 티켓 기반 주 신호.
    (crossValidation?.scored ?? []).forEach((x, i) => add(x.number, Math.max(3, 12 - i), '용지교차'));
    // ② 통합 예측신호(추첨기+후속+클래식+용지+평행+미출 6소스) — 티켓 없어도 산출.
    const unified = predictionSignals?.strong_candidates ?? resolvedStrongCandidates ?? [];
    unified.forEach((n, i) => add(n, Math.max(2, 10 - i * 0.5), '통합신호'));
    // ③ 평행회차 강수/기대 — 보조.
    parallelStrong.forEach((n, i) => add(n, Math.max(1.5, 6 - i * 0.4), '평행강수'));
    parallelExpected.forEach((n, i) => add(n, Math.max(1, 4 - i * 0.3), '평행기대'));

    const ranked = Object.keys(score)
      .map(Number)
      .map((n) => ({ number: n, score: r2(score[n]), sources: [...(srcMap[n] ?? [])] }))
      .sort((a, b) => b.score - a.score || a.number - b.number);
    if (ranked.length < 6) return null;
    const maxScore = ranked[0].score || 1;
    const withPct = ranked.map((r) => ({ ...r, pct: Math.round((r.score / maxScore) * 100) }));

    // 대표 조합 — 상위에서 구간(10단위) 최대 2개 균형으로 6개.
    const decadeOf = (n: number) => Math.min(4, Math.floor((n - 1) / 10));
    const pick: number[] = [];
    const dc: Record<number, number> = {};
    for (const r of withPct) {
      if (pick.length >= 6) break;
      const d = decadeOf(r.number);
      if ((dc[d] ?? 0) >= 2) continue;
      pick.push(r.number);
      dc[d] = (dc[d] ?? 0) + 1;
    }
    for (const r of withPct) {
      if (pick.length >= 6) break;
      if (!pick.includes(r.number)) pick.push(r.number);
    }
    const representative = pick.slice(0, 6).sort((a, b) => a - b);
    // 분산 최적 대안(확률 불변, 공동당첨 회피).
    const shareOpt = optimizeForSharing(withPct.map((r) => r.number), 12);

    const ticketCount = crossValidation?.scored.length ?? 0;
    // hasTickets 는 '용지가 있는가'(한쪽만 올려도 true)여야 한다. 교차검증 수(양쪽 모두
    // 필요)로 판단하면 자동만/반자동만 올린 사용자에게 '용지 없음'으로 오표기된다.
    const hasTickets =
      groupLineMatching.autoLineCount + groupLineMatching.semiLineCount > 0;
    const signalTiers = {
      용지교차: ticketCount > 0, // 교차는 양쪽 줄이 모두 있어야 성립
      통합신호: unified.length > 0,
      평행: parallelStrong.length > 0 || parallelExpected.length > 0,
    };
    return {
      ranked: withPct.slice(0, 15),
      representative,
      shareOpt,
      hasTickets,
      signalTiers,
    };
  }, [compareWinning, crossValidation, predictionSignals, resolvedStrongCandidates, parallelStrong, parallelExpected, groupLineMatching.autoLineCount, groupLineMatching.semiLineCount]);

  // 🎯 최종 강수·기대수 (구간별 신호 종합) — '1:1 강수&기대(반복도)'를 시작점으로,
  // 검증 학습·이월이 함께 가리키는 번호를 점수로 가산한다. 당첨은 사후 대조만.
  // ⚠️ 합의(agreement) 우선 정렬 금지 — 이월 배지만으로 순위가 뒤집히던 회귀 있음.
  const finalStrongExpected = useMemo(() => {
    if (!decadePattern) return null;
    const valByNum = new Map<number, { weight: number; sources: Set<string> }>();
    for (const v of sheetLearningSignals) {
      const e = valByNum.get(v.number) ?? { weight: 0, sources: new Set<string>() };
      e.weight = Math.max(e.weight, v.weight);
      e.sources.add(v.label);
      valByNum.set(v.number, e);
    }
    const co = carryoverQuery.data;
    // 이월 current_candidates 는 다음 회차 forward — 복기 순위에 넣으면 로딩 후 recall 붕괴.
    const applyCarry = !compareWinning;
    const carrySet = new Set(
      applyCarry && co?.ok ? (co.current_candidates ?? []).map((c) => c.number) : [],
    );
    const carryFlat = co?.calibration_flat ?? true;

    const glyph = (fams: string[]) =>
      fams.map((f) => (f === '반복' ? '🔁' : f === '학습' ? '🧠' : '↪')).join('');

    const scoreOne = (p: { number: number; auto: number; semi: number; maxMatch: number; winning: boolean }, repWeight: number) => {
      const val = valByNum.get(p.number);
      const isCarry = carrySet.has(p.number);
      const families: string[] = ['반복'];
      if (val) families.push('학습');
      if (isCarry) families.push('이월');
      // 이월은 검증(비평탄)일 때만 점수 가산 — 평탄이면 배지만(참고).
      const score = repWeight + (val ? 1.5 * val.weight : 0) + (isCarry && !carryFlat ? 0.8 : 0);
      return {
        number: p.number,
        auto: p.auto,
        semi: p.semi,
        maxMatch: p.maxMatch,
        winning: p.winning,
        score,
        families,
        glyphs: glyph(families),
        agreement: families.length,
        valSources: val ? Array.from(val.sources) : [],
        carry: isCarry,
      };
    };

    const bands = decadePattern.byBand.map((b) => {
      const pool = [
        ...b.strong.map((s) => scoreOne(s, 2)),
        ...b.expected.map((s) => scoreOne(s, 1)),
      ].sort((a, b2) => b2.score - a.score || a.number - b2.number);
      return { label: b.label, strong: pool.slice(0, 3), expected: pool.slice(3, 6) };
    });

    const allScored = bands.flatMap((b) => [...b.strong, ...b.expected]);
    // 점수 우선 — agreement 우선이면 이월·학습 배지만으로 1:1 강수가 밀림.
    const consensus = [...allScored].sort(
      (a, b) => b.score - a.score || b.agreement - a.agreement || a.number - b.number,
    );
    const winHit = compareWinning && winningSet
      ? {
          strong: bands.flatMap((b) => b.strong).filter((s) => winningSet.has(s.number)).length,
          multi: consensus.filter((c) => c.agreement >= 2 && winningSet.has(c.number)).length,
          multiTotal: consensus.filter((c) => c.agreement >= 2).length,
        }
      : null;
    return { bands, consensus, winHit, carryFlat };
  }, [decadePattern, sheetLearningSignals, carryoverQuery.data, compareWinning, winningSet]);

  // 🧪 강수·기대 엔진 접목 — 서버 API 권위(graft-v2). 로컬은 API 실패 시에만 폴백.
  const graftCoverageEV = useMemo(() => {
    const api = graftCoverageQuery.data;
    const rv = reviewVerificationQuery.data;
    const wf = rv?.ok ? rv.expand_walkforward : undefined;
    const wfInfo = wf
      ? {
          rounds: wf.rounds ?? null,
          random: wf.random_baseline ?? 3.2,
          top18: wf.means_by_size?.['18'] ?? null,
          top24: wf.means_by_size?.['24'] ?? null,
          sizeLift: wf.size_lift_24_vs_18 ?? null,
        }
      : null;

    if (api?.ok && (api.core6?.length ?? 0) >= 6 && (api.expand24?.length ?? 0) >= 6) {
      const core6 = api.core6!;
      const expand = api.expand24!;
      const shareOpt = api.share_opt?.length === 6 ? api.share_opt : (api.share_opt ?? []);
      const audit = api.audit;
      const winsReady = Boolean(compareWinning && (audit?.winning?.length || (winningSet && winningSet.size > 0)));
      return {
        fromApi: true as const,
        pending: false,
        core6,
        expand,
        shareOpt: shareOpt.slice(0, 6),
        shareResult: api.share_meta
          ? {
              numbers: shareOpt.slice(0, 6),
              assessment: {
                risk: api.share_meta.risk ?? 50,
                evScore: api.share_meta.ev_score ?? 50,
                grade: ((api.share_meta.ev_score ?? 50) >= 70
                  ? 'excellent'
                  : (api.share_meta.ev_score ?? 50) >= 55
                    ? 'good'
                    : (api.share_meta.ev_score ?? 50) >= 40
                      ? 'fair'
                      : 'poor') as 'excellent' | 'good' | 'fair' | 'poor',
                factors: [],
                summary: api.data_used?.ev_mode_label ?? 'recall-EV',
              },
            }
          : null,
        bothSideCount: api.both_side_core ?? 0,
        rawTop6: api.raw_top6 ?? [],
        wf: wfInfo,
        reviewHit: winsReady
          ? {
              core6: audit?.selected_core6_hits ?? core6.filter((n) => winningSet?.has(n)).length,
              expand: audit?.expand24_hits ?? expand.filter((n) => winningSet?.has(n)).length,
              share: audit?.recall_ev6_hits
                ?? shareOpt.filter((n) => winningSet?.has(n)).length,
              rawTop6: audit?.raw_top6_hits ?? 0,
              pureEv: audit?.pure_ev6_hits ?? null,
              multi: null,
              multiTotal: null,
            }
          : null,
        outsideCoreInExpand: audit?.outside_core_in_expand ?? [],
        dataUsed: api.data_used ?? null,
        backtest: api.backtest ?? null,
        graftBuild: api.graft_build ?? 'graft-v3-raw-first',
        honesty: api.honesty ?? null,
        rankSource: 'api_pair_product' as const,
        decadeDropped: audit?.decade_dropped_vs_raw ?? [],
      };
    }

    // 로컬 폴백 (API 로딩/실패) — 구간커버·recall 창 EV
    if (graftCoverageQuery.isLoading || graftCoverageQuery.isFetching) {
      return {
        fromApi: false as const,
        pending: true,
        core6: [] as number[],
        expand: [] as number[],
        shareOpt: [] as number[],
        shareResult: null,
        bothSideCount: 0,
        rawTop6: [] as number[],
        wf: wfInfo,
        reviewHit: null,
        outsideCoreInExpand: [] as number[],
        dataUsed: null,
        backtest: null,
        graftBuild: null,
        honesty: null,
        rankSource: 'pending' as const,
        decadeDropped: [] as number[],
      };
    }
    if (predictedNumbers.length < 6) return null;
    const consensus = finalStrongExpected?.consensus ?? [];
    const tipByNum = new Map(consensus.map((c) => [c.number, c.score]));
    const meta = new Map(
      predictedNumbers.map((p, idx) => {
        const tip = tipByNum.get(p.number) ?? 0;
        const graftScore = (predictedNumbers.length - idx) * 10 + tip * 0.25;
        return [
          p.number,
          { auto: p.auto, semi: p.semi, maxMatch: p.maxMatch, score: graftScore },
        ] as const;
      }),
    );
    const graftRanked = [...meta.entries()]
      .map(([number, m]) => ({ number, graftScore: m.score }))
      .sort((a, b) => b.graftScore - a.graftScore || a.number - b.number)
      .map((x) => x.number);
    // 로컬 폴백도 서버 v3 와 동일: 핵심·확장 = raw 1:1 (구간커버 강제 금지)
    const rawTop6 = graftRanked.slice(0, 6);
    const expand = graftRanked.slice(0, Math.min(24, graftRanked.length));
    const core6 = rawTop6;
    const bothSideCount = core6.filter((n) => {
      const m = meta.get(n);
      return Boolean(m && m.auto > 0 && m.semi > 0);
    }).length;
    const top12 = new Set(expand.slice(0, 12));
    const top6set = new Set(rawTop6);
    const shareResult = optimizeForSharing(expand, Math.min(24, expand.length));
    let shareOpt = shareResult ? shareResult.numbers.slice(0, 6) : [];
    const fromTop12 = shareOpt.filter((n) => top12.has(n)).length;
    const fromTop6 = shareOpt.filter((n) => top6set.has(n)).length;
    if (shareOpt.length === 6 && (fromTop12 < 4 || fromTop6 < 2)) {
      const keep = [
        ...rawTop6.filter((n) => expand.includes(n)).slice(0, 2),
        ...expand.filter((n) => top12.has(n) && !rawTop6.slice(0, 2).includes(n)).slice(0, 2),
      ];
      const uniqKeep = Array.from(new Set(keep)).slice(0, 4);
      const merged = [...uniqKeep];
      for (const n of shareOpt) {
        if (merged.length >= 6) break;
        if (!merged.includes(n)) merged.push(n);
      }
      for (const n of expand) {
        if (merged.length >= 6) break;
        if (!merged.includes(n)) merged.push(n);
      }
      shareOpt = merged.slice(0, 6).sort((a, b) => a - b);
    }
    const winsReady = Boolean(compareWinning && winningSet && winningSet.size > 0);
    const coreSet = new Set(core6);
    const expandSet = new Set(expand);
    return {
      fromApi: false as const,
      pending: false,
      core6,
      expand,
      shareOpt,
      shareResult,
      bothSideCount,
      rawTop6,
      wf: wfInfo,
      reviewHit: winsReady
        ? {
            core6: core6.filter((n) => winningSet!.has(n)).length,
            expand: expand.filter((n) => winningSet!.has(n)).length,
            share: shareOpt.filter((n) => winningSet!.has(n)).length,
            rawTop6: rawTop6.filter((n) => winningSet!.has(n)).length,
            pureEv: null as number | null,
            multi: null,
            multiTotal: null,
          }
        : null,
      outsideCoreInExpand: winsReady
        ? [...winningSet!].filter((n) => expandSet.has(n) && !coreSet.has(n)).sort((a, b) => a - b)
        : [],
      dataUsed: {
        sheet_source: 'local_browser',
        auto_line_count: undefined as number | undefined,
        semi_line_count: undefined as number | undefined,
        fixed_semi_excluded: [] as number[],
        signal: 'pair_product',
        signal_label: '1:1 곱(로컬 폴백)',
        core_mode_label: 'raw 1:1 top6 (기본)',
        ev_mode_label: 'recall-EV + top6 바닥',
        note: '서버 API 실패/대기 — 로컬 raw 1:1',
      },
      backtest: null,
      graftBuild: 'local-fallback-v3',
      honesty: null,
      rankSource: 'local_fallback' as const,
      decadeDropped: [] as number[],
    };
  }, [
    graftCoverageQuery.data,
    graftCoverageQuery.isLoading,
    graftCoverageQuery.isFetching,
    predictedNumbers,
    finalStrongExpected,
    reviewVerificationQuery.data,
    compareWinning,
    winningSet,
  ]);

  // 🎯 핵심 추천 — 탭별 대상 회차가 다름.
  // 복기: 서버 review_coverage_set 확정 전에는 표시하지 않음(로컬 폴백이 '검증 추천'으로
  // 보이며 당첨 로드 후 세트가 바뀌는 착시·레이스 방지). 이번회차만 로컬 폴백 허용.
  const heroRecommendation = useMemo(() => {
    const empty = {
      ready: false,
      pending: false,
      pendingReason: '' as string,
      verified: false,
      winsReady: false,
      contrastPending: false,
      core6: [] as number[],
      expand18: [] as number[],
      expandSize: 24,
      shareOpt: [] as number[],
      source: 'coverage' as 'consensus' | 'coverage' | 'forecast' | 'repeat',
      sourceLabel: '',
      signalLabel: '자동↔반자동 양쪽 지지',
      selectedByMulti: false,
      bestTop18: null as number | null,
      reviewRounds: 0,
      goodSignalCount: 0,
      agreement: {} as Record<string, number>,
      showWinning: compareWinning,
      coverageMode: null as string | null,
      expandModeLabel: null as string | null,
      outsideExpand: [] as number[],
      missedDetail: [] as { number: number; single_rank?: number; boe_rank?: number }[],
      expandHitCount: null as number | null,
      core6HitCount: null as number | null,
      serverRound: null as number | null,
      selectedBy: null as string | null,
      pairDiag: null as { core6Count: number; expandCount: number } | null,
      sheetMeta: '' as string,
    };
    const rv = reviewVerificationQuery.data;
    const clean = (arr: number[] | undefined) =>
      Array.from(new Set((arr ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 45)));
    const consensus = rv?.ok
      ? compareWinning
        ? rv.review_consensus_coverage
        : rv.consensus_coverage
      : undefined;
    const cov = rv?.ok
      ? compareWinning
        ? rv.review_coverage_set
        : rv.current_coverage_set
      : undefined;
    const lb = rv?.ok ? rv.signal_leaderboard : undefined;
    const policy = rv?.ok ? rv.inverse_diagnosis?.policy : undefined;
    const best =
      lb?.leaderboard?.find((e) => e.key === lb.best_signal_multi) ?? lb?.leaderboard?.[0];
    const coreMode = policy?.core6_mode ?? (policy?.prefer_consensus ? 'consensus' : 'best_single');
    const expandMode = policy?.expand18_mode ?? 'best_of_engines';
    let core6 = clean(
      coreMode === 'consensus' ? (consensus?.core6 ?? cov?.core6) : (cov?.core6 ?? consensus?.core6)
    );
    let source: 'consensus' | 'coverage' | 'forecast' | 'repeat' =
      coreMode === 'consensus' && (consensus?.core6?.length ?? 0) >= 6 ? 'consensus' : 'coverage';
    if (core6.length < 6) {
      core6 = clean(coreMode === 'consensus' ? cov?.core6 : consensus?.core6);
      if (core6.length >= 6) source = coreMode === 'consensus' ? 'coverage' : 'consensus';
    }
    let expand18 = clean(
      expandMode === 'consensus'
        ? (consensus?.expand18 ?? cov?.expand18)
        : (cov?.expand18 ?? consensus?.expand18)
    );
    if (expand18.length < 6) {
      expand18 = clean(expandMode === 'consensus' ? cov?.expand18 : consensus?.expand18);
    }
    const expandSizeHint = Math.max(
      expand18.length,
      Number(cov?.expand_size ?? policy?.expand_size ?? 24) || 24,
      24,
    );
    const serverReady = Boolean(rv?.ok && core6.length >= 6 && expand18.length >= 6);

    // 복기 탭: 서버 검증 전엔 ready=false (로컬 predictedNumbers 폴백 금지).
    // 회차 불일치(옛 캐시)도 검증 완료로 위장하지 않음.
    const serverRound = rv?.ok ? rv.round_no : null;
    const roundMismatch =
      compareWinning
      && serverReady
      && effectiveRound != null
      && serverRound != null
      && serverRound !== effectiveRound;
    if (compareWinning && (!serverReady || roundMismatch)) {
      const loading = reviewVerificationQuery.isLoading || reviewVerificationQuery.isFetching;
      return {
        ...empty,
        pending: true,
        pendingReason: roundMismatch
          ? `서버 검증은 ${serverRound}회 · 화면 복기는 ${effectiveRound}회 — 회차 맞춰 재계산 중…`
          : loading
            ? '복기 검증 API 계산 중… 임시 로컬 순위를 검증 추천으로 보여주지 않습니다.'
            : (rv && !rv.ok
              ? (rv.reason ?? '복기 검증 데이터가 없습니다.')
              : '복기 용지 검증 커버리지 대기 중…'),
        reviewRounds: lb?.rounds ?? 0,
        serverRound,
      };
    }

    // 이번회차만 — 서버 없으면 로컬 폴백.
    if (!compareWinning && (core6.length < 6 || expand18.length < 6)) {
      const rep = currentRoundForecast?.representative ?? [];
      const predTop = predictedNumbers.map((p) => p.number);
      const signalTop = (predictionSignals?.strong_candidates ?? []).filter(
        (n) => Number.isInteger(n) && n >= 1 && n <= 45
      );
      const pool = predTop.length >= 6 ? predTop : signalTop.length >= 6 ? signalTop : predTop;
      if (core6.length < 6) {
        core6 = clean(rep.length >= 6 ? rep : pool.slice(0, 6));
        source = rep.length >= 6 ? 'forecast' : 'repeat';
      }
      if (expand18.length < 6) expand18 = clean(pool.slice(0, expandSizeHint));
    }

    const ready = core6.length >= 6 && expand18.length >= 6;
    const wide = clean(expand18).slice(
      0,
      Math.min(30, Math.max(expand18.length, Number(cov?.expand_size) || 0)),
    );
    const shareResult = ready ? optimizeForSharing(wide, Math.min(24, wide.length)) : null;
    const shareOpt = shareResult ? shareResult.numbers.slice(0, 6) : [];
    const agreement = consensus?.agreement ?? {};
    const winsReady = Boolean(winningSet && winningSet.size > 0);
    const audit = compareWinning && rv?.ok ? rv.review_hit_audit : undefined;
    // 서버 audit 만 사용 — 폴백 expand 에 당첨 차집합을 붙이면 레이스 중 수치가 흔들림.
    const outsideExpand = clean(audit?.outside_expand ?? audit?.missed_catchable).sort(
      (a, b) => a - b,
    );
    const missedDetail = (audit?.missed_detail ?? []).filter((m) =>
      outsideExpand.includes(m.number),
    );
    const selectedBy = cov?.selected_by ?? null;
    const sourceLabel =
      source === 'coverage'
        ? selectedBy === 'loo_held'
          ? '서버 검증(LOO·이 회차 제외)'
          : '서버 검증 커버리지'
        : source === 'consensus'
          ? '검증 통과 합의'
          : source === 'forecast'
            ? '이번회차 종합예측'
            : '로컬 1:1 임시';
    const pairDiagRaw = compareWinning && cov && 'pair_product_diag' in cov
      ? (cov as { pair_product_diag?: { core6_count?: number; expand24_count?: number } }).pair_product_diag
      : undefined;
    const reviewPolicy = rv?.ok ? rv.review_policy : undefined;
    const sheetMeta = reviewPolicy
      ? `용지 ${reviewPolicy.sheet_source ?? '?'} · 자동 ${reviewPolicy.auto_line_count ?? 0}줄 · 반자동 ${reviewPolicy.semi_line_count ?? 0}줄`
      : '';
    return {
      ready,
      pending: false,
      pendingReason: '',
      verified: serverReady,
      winsReady,
      contrastPending: Boolean(compareWinning && !winsReady),
      core6: [...core6].slice(0, 6).sort((a, b) => a - b),
      expand18: [...wide].sort((a, b) => a - b),
      expandSize: wide.length || expandSizeHint,
      shareOpt: [...shareOpt].sort((a, b) => a - b),
      source,
      sourceLabel,
      signalLabel: cov?.signal_label ?? best?.label ?? '자동↔반자동 양쪽 지지',
      selectedByMulti: selectedBy === 'multi_round',
      selectedBy,
      bestTop18: best?.mean_top18 ?? (rv?.ok ? rv.summary?.best_top18 : null) ?? null,
      reviewRounds: lb?.rounds ?? 0,
      goodSignalCount: source === 'consensus' ? (consensus?.good_signal_count ?? 0) : 0,
      agreement: source === 'consensus' ? agreement : {},
      showWinning: compareWinning,
      coverageMode: rv?.ok ? rv.inverse_diagnosis?.policy?.coverage_mode ?? null : null,
      expandModeLabel:
        cov?.expand18_mode_label
        ?? rv?.inverse_diagnosis?.policy?.expand18_variant_label
        ?? null,
      outsideExpand,
      missedDetail,
      expandHitCount: audit?.expand18_count
        ?? (winsReady ? wide.filter((n) => winningSet!.has(n)).length : null),
      core6HitCount: audit?.core6_count
        ?? (winsReady ? core6.filter((n) => winningSet!.has(n)).length : null),
      serverRound,
      pairDiag: pairDiagRaw
        ? {
            core6Count: Number(pairDiagRaw.core6_count ?? 0),
            expandCount: Number(pairDiagRaw.expand24_count ?? 0),
          }
        : null,
      sheetMeta,
    };
  }, [
    compareWinning,
    effectiveRound,
    reviewVerificationQuery.data,
    reviewVerificationQuery.isLoading,
    reviewVerificationQuery.isFetching,
    currentRoundForecast,
    predictedNumbers,
    predictionSignals?.strong_candidates,
    winningSet,
  ]);

  // 종합분석 Venus/학습 추첨용 — intent별 스냅샷(복기·이번회차 분리 저장).
  useEffect(() => {
    const snap = buildDetailForecastSnapshot({
      intent: sheetIntent,
      round: effectiveRound ?? (sheetIntent === 'current_round' ? currentRound : null) ?? null,
      forecastRanked:
        sheetIntent === 'current_round' ? (currentRoundForecast?.ranked ?? null) : null,
      predictedRanked: predictedNumbers.map((p) => ({
        number: p.number,
        confidence: p.confidence,
        sources: p.sources,
      })),
      core6: heroRecommendation.core6,
      expand18: heroRecommendation.expand18,
      representative:
        sheetIntent === 'current_round'
          ? (currentRoundForecast?.representative ?? heroRecommendation.core6)
          : heroRecommendation.core6,
    });
    if (snap) saveDetailForecast(snap);
  }, [
    sheetIntent,
    effectiveRound,
    currentRound,
    currentRoundForecast,
    predictedNumbers,
    heroRecommendation.core6,
    heroRecommendation.expand18,
  ]);



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

    // seedTickets 는 reviewRecommendationEngine(3축: 1:1 전수비교·평행·프로파일)이
    // 더 이상 소비하지 않는다(점수·후보생성에서 제거됨). 과거엔 복기 탭에서 당첨
    // 일치수(vsLatestMatch)로 시드 가중을 매겨 '사후 편향(누수)' 처럼 보였지만, 실제로는
    // 엔진이 이 값을 읽지 않았다. 혼선·헛계산을 없애기 위해 빈 배열로 전달한다.
    const seedTickets: { ticket: number[]; weight: number; label: string }[] = [];

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
        parallelStrong,
        parallelExpected,
        machineStrong,
        // 🧬 학습된 당첨 프로파일 매칭(복기 당첨 구조 → 현재 데이터 전이) — 핵심 축.
        profileMatched: patternMatched?.list.map((m) => ({ number: m.number, sim: m.sim })),
        // 🧬 학습된 당첨 조합 구조(합계·홀수·구간분산·연속) — 조합 형태 정합 가산.
        learnedStructure: learnedPattern?.structure,
        validatedLearning: sheetLearningSignals,
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
    parallelStrong,
    parallelExpected,
    machineStrong,
    patternMatched,
    learnedPattern,
    sheetLearningSignals,
  ]);

  /**
   * 대량 입력 — append + dedup.
   *
   * 이전: setBulkTickets(lines) 가 모두 덮어씀
   * 이후: 기존 bulkTickets 에 new lines 를 append, 중복(같은 6-튜플) 제거.
   * → 매번 새로 입력해도 사라지지 않고 누적됨 (사용자 요청).
   * → 명시 초기화 ('대량 결과 초기화') 시에만 비워짐.
   */
  // 이미 등록·저장된 반자동 줄 키 — 대량입력 시 누적 겹침 검증용 (서버 누적 + 로컬 버킷)
  const existingSemiKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const a of accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines ?? []) keys.add(lineKey(a));
    for (const t of bulkTickets) keys.add(lineKey(t));
    for (const slip of semiSlipQueue) for (const l of slip.lines) keys.add(lineKey(l.numbers));
    for (const l of semiCurrentLines) keys.add(lineKey(l.numbers));
    return keys;
  }, [accumulated, sheetIntent, bulkTickets, semiSlipQueue, semiCurrentLines]);

  // 서버에 저장된 반자동 줄 키 (미저장 판정 기준) — 자동과 동일하게 '서버 기준'.
  // lastSavedAt(시각) 만으로 판정하던 기존 방식은 하이드레이션·기기간 동기화 후
  // '미저장' 오표기를 냈다. 실제 줄을 서버 saved_semi_lines 와 대조한다.
  const savedSemiKeySet = useMemo(
    () => new Set((accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines ?? []).map(lineKey)),
    [accumulated, sheetIntent]
  );
  const serverSemiSavedCount = accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines?.length ?? 0;
  // 진짜 '미저장' 로컬 줄 수 — 서버에 아직 없는 줄만 (중복 제외).
  const unsavedSemiCount = useMemo(() => {
    const seen = new Set<string>();
    const consider = (k: string) => {
      if (!savedSemiKeySet.has(k)) seen.add(k);
    };
    for (const t of bulkTickets) consider(lineKey(t));
    for (const slip of semiSlipQueue) for (const l of slip.lines) consider(lineKey(l.numbers));
    for (const l of semiCurrentLines) consider(lineKey(l.numbers));
    return seen.size;
  }, [savedSemiKeySet, bulkTickets, semiSlipQueue, semiCurrentLines]);

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
    <Stack spacing={2}>
      {/* ════════ ① 번호 등록 (자동 + 반자동 한 세트) ════════ */}
      <Paper sx={{ p: 2 }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: showRegister ? 1 : 0 }} spacing={1}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 0.25 }}>
            <Typography variant="subtitle1" fontWeight={800}>
              ① 번호 등록
            </Typography>
            <Chip size="small" variant="outlined" label={intentSectionLabel} sx={{ height: 20, fontSize: 10 }} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            자동·반자동 용지 등록 → 저장하면 ② 분석·③ 추천에 반영됩니다.{' '}
            {compareWinning
              ? '복기 — 당첨번호·누적 강한후보·교집합과 대조합니다.'
              : '이번회차 — 당첨번호 없이 줄간 겹침·강한 후보만 봅니다.'}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.75} flexShrink={0}>
          <Button
            type="button"
            size="small"
            variant="outlined"
            disabled={isReanalyzing}
            onClick={() => void handleReanalyze()}
            sx={{ minWidth: 88, zIndex: 2 }}
          >
            {isReanalyzing ? (
              <><CircularProgress size={14} sx={{ mr: 0.5 }} />재분석…</>
            ) : (
              '↻ 재분석'
            )}
          </Button>
          <Button size="small" variant="outlined" onClick={() => setShowRegister((v) => !v)}>
            {showRegister ? '접기 ▲' : '펼치기 ▼'}
          </Button>
        </Stack>
      </Stack>

      {showRegister && (
      <>
      {registerPrelude}
      <Divider textAlign="left" sx={{ my: 2 }}>
        <Typography variant="caption" fontWeight={800} color="text.secondary">
          반자동 용지
        </Typography>
      </Divider>
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

      {isExtremeVolume && (
        <Alert
          severity={suspendHeavyComparison ? 'warning' : 'success'}
          sx={{ mb: 1.5 }}
          action={
            suspendHeavyComparison ? (
              <Button color="warning" size="small" variant="outlined" onClick={() => setForceDetailedComparison(true)}>
                전체 전수비교 실행
              </Button>
            ) : (
              <Button color="inherit" size="small" onClick={() => setForceDetailedComparison(false)}>
                다시 보류
              </Button>
            )
          }
        >
          {suspendHeavyComparison ? (
            <>
              매우 대량({combinedTicketEstimate.toLocaleString()}줄 · 약{' '}
              {estimatedLinePairCount.toLocaleString()}페어)이라 계산이 몇 초 걸릴 수 있어 잠시 보류했습니다.
              <strong> [전체 전수비교 실행]</strong>으로 샘플링 없이 전체 분석합니다(카드·줄은 페이지·캡으로 렌더).
            </>
          ) : (
            <>
              전체 {combinedTicketEstimate.toLocaleString()}줄 · 약{' '}
              {estimatedLinePairCount.toLocaleString()}페어 <strong>1:1 전수비교</strong> 표시 중(샘플링 없음).
            </>
          )}
        </Alert>
      )}
      {isHeavyVolume && !isExtremeVolume && (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          전체 {combinedTicketEstimate.toLocaleString()}줄 · 약{' '}
          {estimatedLinePairCount.toLocaleString()}페어 <strong>1:1 전수비교</strong> 진행 중(샘플링 없음).
          예상번호·강수/기대 등 분석은 <strong>전체로 계산</strong>하고,{' '}
          {IS_CONSTRAINED_DEVICE ? '모바일에선 카드·줄 목록만 페이지·캡으로' : '카드는 페이지로'} 나눠 렌더합니다.
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
                반자동 누적: {semiSlipQueue.length}장 · 입력 중 {semiCurrentLines.length}/{GAME_LABELS.length}줄 · 대량 {bulkTickets.length}장 · 총 {ticketLines.length}줄 (서버 저장 반자동 {serverSemiSavedCount}줄)
              </Typography>
              {ticketLines.length > 0 && (
                <Chip
                  size="small"
                  color={unsavedSemiCount === 0 ? 'success' : 'warning'}
                  label={
                    unsavedSemiCount === 0
                      ? `모두 저장됨 (서버 반자동 ${serverSemiSavedCount}줄)`
                      : `미저장 ${unsavedSemiCount}줄 — [💾 누적·저장] 클릭`
                  }
                  sx={{ fontSize: 11 }}
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              ※ [💾 누적·저장] 클릭 시 백엔드에 저장되어 통계에 반영됩니다. 새로고침 전에 반드시 저장하세요.
              아래 목록의 [×] 로 개별 줄 삭제.
            </Typography>

            {/* ⛔ 회차 불일치 경고 — 지난 회차 로컬을 현재 회차로 재저장하면 오염된다. */}
            {staleLocalRound && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                이 로컬 누적은 <strong>{localRoundNo}회 기준</strong>인데 현재 탭은{' '}
                <strong>{effectiveRound}회</strong>입니다. 이대로 [💾 누적·저장] 하면{' '}
                <strong>{effectiveRound}회 데이터로 재라벨링</strong>되어 회차가 뒤섞입니다.
                저장 시 확인창이 뜨며, 정리하려면 [반자동 누적 전체 삭제] 를 사용하세요.
              </Alert>
            )}

            {/* 로컬↔서버 드리프트 경고 + [서버 기준 동기화] — 자동 탭과 대칭.
                로컬(이 기기)이 서버 저장분과 다를 때 서버 기준으로 맞춘다. */}
            {unsavedSemiCount > 0 && serverSemiSavedCount > 0 && (() => {
              const localKeys = new Set<string>();
              for (const t of bulkTickets) localKeys.add(lineKey(t));
              for (const slip of semiSlipQueue) for (const l of slip.lines) localKeys.add(lineKey(l.numbers));
              for (const l of semiCurrentLines) localKeys.add(lineKey(l.numbers));
              const matched = [...localKeys].filter((k) => savedSemiKeySet.has(k)).length;
              return (
                <Alert
                  severity={matched === 0 ? 'warning' : 'info'}
                  sx={{ mb: 1.5 }}
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      variant="outlined"
                      onClick={async () => {
                        const serverLines = accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines ?? [];
                        if (!serverLines.length) return;
                        const ok = await confirm({
                          message: `로컬 반자동 누적(${localKeys.size}줄)을 버리고 서버 저장분(${serverLines.length}줄)으로 맞출까요? 서버에 없는 로컬 줄은 사라집니다. (반대로 로컬을 올리려면 [💾 누적·저장])`,
                          destructive: true,
                          confirmText: '서버 기준으로 동기화',
                        });
                        if (!ok) return;
                        setBulkTickets(serverLines.map((l) => [...l]));
                        setSemiSlipQueue([]);
                        setSemiCurrentLines([]);
                        setLastSavedAt(new Date().toISOString());
                        // 서버 기준으로 맞췄으니 회차 stamp 도 현재 대상 회차로 갱신 —
                        // 안 하면 낡은 localRoundNo 때문에 '회차 불일치' 경고가 계속 뜬다.
                        setLocalRoundNo(effectiveRound ?? null);
                        setSaveNotice(`서버 저장분 ${serverLines.length}줄로 로컬 반자동 누적을 동기화했습니다.`);
                      }}
                    >
                      서버 기준 동기화
                    </Button>
                  }
                >
                  📋 로컬 {localKeys.size}줄 중 서버 일치 <strong>{matched}줄</strong> · 미반영 <strong>{unsavedSemiCount}줄</strong>.
                  {matched === 0 ? (
                    <> 서버({serverSemiSavedCount}줄)와 로컬이 <strong>완전히 다릅니다</strong>. 로컬을 서버에 올리려면{' '}
                    <strong>[💾 누적·저장]</strong>, 서버 저장분을 그대로 쓰려면 <strong>[서버 기준 동기화]</strong>.</>
                  ) : (
                    <> 위 <strong>[💾 누적·저장]</strong> 버튼을 눌러야 통계에 반영됩니다.</>
                  )}
                </Alert>
              );
            })()}
            {ticketLines.length === 0 ? (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                반자동 누적이 없습니다. 그리드에서 6개 선택 후 [줄 저장] 하거나 [⬆ 대량 입력] 으로 추가하세요.
              </Alert>
            ) : (
              <Box sx={{ maxHeight: 320, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75, mb: 1 }}>
                <Stack spacing={0.5}>
                  {ticketLines.slice(0, semiListLimit).map((line, idx) => {
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
                              size={ENGINE_BALL.list}
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
            {ticketLines.length > SEMI_LIST_PAGE && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                {semiListLimit < ticketLines.length && (
                  <Button
                    size="small"
                    variant="text"
                    onClick={() =>
                      setSemiListLimit((v) => Math.min(v + SEMI_LIST_PAGE, ticketLines.length))
                    }
                  >
                    더 보기 (+{Math.min(SEMI_LIST_PAGE, ticketLines.length - semiListLimit)}) · {semiListLimit}/{ticketLines.length}줄
                  </Button>
                )}
                {semiListLimit >= ticketLines.length ? (
                  <Button size="small" variant="text" onClick={() => setSemiListLimit(SEMI_LIST_PAGE)}>
                    접기 ▲ (전체 {ticketLines.length}줄)
                  </Button>
                ) : (
                  <Button size="small" variant="text" onClick={() => setSemiListLimit(ticketLines.length)}>
                    전체 보기 ({ticketLines.length}줄)
                  </Button>
                )}
              </Stack>
            )}
            <Stack direction="row" justifyContent="flex-end">
              <Button
                size="small"
                color="error"
                variant="outlined"
                onClick={clearAllSaved}
                disabled={
                  ticketLines.length === 0 &&
                  (accumulated?.by_intent?.[sheetIntent]?.saved_semi_lines?.length ?? 0) === 0
                }
              >
                반자동 누적 전체 삭제
              </Button>
            </Stack>
          </>
        );
      })()}

      </>
      )}
      </Paper>

      {/* ════════ ② 번호 분석 결과 & 1:1 전수비교 ════════ */}
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: showAnalysisSection ? 1 : 0 }} spacing={1}>
          <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
            <Typography variant="subtitle1" fontWeight={800}>
              ② 번호 분석 · 1:1 전수비교
            </Typography>
            <Chip size="small" variant="outlined" label={intentSectionLabel} sx={{ height: 20, fontSize: 10 }} />
          </Stack>
          <Button size="small" variant="outlined" onClick={() => setShowAnalysisSection((v) => !v)}>
            {showAnalysisSection ? '접기 ▲' : '펼치기 ▼'}
          </Button>
        </Stack>
        {!showAnalysisSection && (
          <Typography variant="caption" color="text.secondary">
            빈도·1:1 요약·매칭 상세·누적/회차별 데이터
          </Typography>
        )}
        {showAnalysisSection && (
        <>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.25 }}>
        빈도 → 1:1 요약/상세 → 누적·회차별 데이터 순으로 봅니다. 학습 엔진(L1~L8·V1~V4)은{' '}
        <Button
          size="small"
          variant="text"
          sx={{ minWidth: 0, p: 0, verticalAlign: 'baseline', fontSize: 11, fontWeight: 700 }}
          onClick={() => {
            setShowPredictionDetail(true);
            setEngineTab('learn');
            requestAnimationFrame(() =>
              document.getElementById('engine-reverse')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            );
          }}
        >
          ④ 패턴 분석 엔진
        </Button>
        에서 확인하세요.
      </Typography>
      {analysisPrelude}
      {/* 반자동 누적 기반 빈도 — 자동 분석과 분리, 반자동 누적만 카운트 */}
      {(semiCurrentLines.length > 0 || semiSlipQueue.length > 0 || bulkTickets.length > 0) && (
        <Box sx={{ mb: 1.5 }}>
          <NumberFrequencyPanel
            lines={[
              ...semiCurrentLines.map((l) => l.numbers),
              ...semiSlipQueue.flatMap((s) => s.lines.map((l) => l.numbers)),
              ...bulkTickets,
            ]}
            winningSet={winningSet}
            sourceLabel="반자동 누적"
            bodyLabel="반자동 누적"
            emptyHint="반자동 누적이 없습니다. 그리드에서 6개 선택 후 [줄 저장] 으로 누적하세요."
            defaultOpen={false}
          />
        </Box>
      )}

      {/* 비교 결과 */}
      {picked.length === 6 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
            📊 {compareWinning ? '4축' : '3축'} 비교 결과
          </Typography>

          {/* 1. vs 최근 당첨 — 복기 탭에서만 (이번회차는 당첨 미사용) */}
          {compareWinning && (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              justifyContent="space-between"
            >
              <Typography variant="body2" fontWeight={700}>
                🎯 vs 당첨 ({comparison.vsLatest.winningNumbers.join(', ') || '데이터 없음'})
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
          )}

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


      {/* ── 1:1 전수비교 요약 (§② 번호 분석 — 학습엔진 아님) ── */}
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
                    onClick={() => {
                      if (showLineMatchDetail) {
                        setShowLineMatchDetail(false);
                        return;
                      }
                      setShowLineMatchDetail(true);
                      window.setTimeout(() => {
                        lineMatchingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 50);
                    }}
                  >
                    {showLineMatchDetail ? '접기 ▲' : '상세 보기 ▼'}
                  </Button>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {intentSectionLabel} · {effectiveRound ?? '?'}회 — 자동↔반자동 줄을 전수 비교해 공통 번호 2개 이상 매치를 집계합니다.
                {canRenderLineMatching && !showLineMatchDetail
                  ? ' 매칭 카드·필터는 [상세 보기]에서 엽니다.'
                  : ''}
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                <Chip size="small" variant="outlined" label={`자동 ${groupLineMatching.autoLineCount}줄`} />
                <Chip size="small" variant="outlined" label={`반자동 ${groupLineMatching.semiLineCount}줄`} />
                {canRenderLineMatching && (
                  <>
                    <Chip size="small" color="secondary" variant="outlined" label={`원본 페어 ${groupLineMatching.rawPairCount}건`} />
                    <Chip size="small" color="secondary" label={`통합 카드 ${groupLineMatching.groupCount}건`} sx={{ fontWeight: 700 }} />
                    {showLineMatchDetail && (
                      <Chip size="small" variant="outlined" label={`현재 표시 ${visibleGroupMatchTotal}건`} />
                    )}
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

      {/* 1:1 전수비교 그룹 — 요약의 [상세 보기]로만 펼침 */}
      {canRenderLineMatching && showLineMatchDetail && (

            <Box ref={lineMatchingRef}>
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'secondary.main' }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }} spacing={1}>
                <Typography variant="body2" fontWeight={700}>
                  🔀 자동 ↔ 반자동 줄 1:1 매칭 (공통 번호 2~6개)
                </Typography>
                <Button
                  type="button"
                  size="small"
                  variant="outlined"
                  onClick={() => setShowLineMatchDetail(false)}
                >
                  접기 ▲
                </Button>
              </Stack>
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
                <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>반자동 일치줄:</Typography>
                  {([
                    ['none', '기본순'],
                    ['desc', '많은순 ▼'],
                    ['asc', '적은순 ▲'],
                  ] as const).map(([val, lbl]) => (
                    <Chip
                      key={`semi-sort-${val}`}
                      size="small"
                      clickable
                      color={semiLineSort === val ? 'secondary' : 'default'}
                      variant={semiLineSort === val ? 'filled' : 'outlined'}
                      label={lbl}
                      onClick={() => setSemiLineSort(val)}
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
                  // 반자동 측 일치 줄 수(semiList)로 정렬 — 기본(none)은 원래 순서(matchCount·지지).
                  const sorted =
                    semiLineSort === 'none'
                      ? groups
                      : [...groups].sort((a, b) =>
                          semiLineSort === 'desc'
                            ? b.semiList.length - a.semiList.length || a.key.localeCompare(b.key)
                            : a.semiList.length - b.semiList.length || a.key.localeCompare(b.key),
                        );
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
                          {sorted.slice(0, groupShowLimit).map((g, idx) => {
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
                                    {g.autoList.slice(0, lineRenderCap).map((a) => (
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
                                            size={ENGINE_BALL.table}
                                            dimmed={winningSet ? !winningSet.has(n) : !mset.has(n)}
                                          />
                                        ))}
                                      </Stack>
                                    ))}
                                    {g.autoList.length > lineRenderCap && (
                                      <Typography variant="caption" color="text.secondary">
                                        …외 자동 {g.autoList.length - lineRenderCap}줄
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
                                    {g.semiList.slice(0, lineRenderCap).map((s) => (
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
                                            size={ENGINE_BALL.table}
                                            dimmed={winningSet ? !winningSet.has(n) : !mset.has(n)}
                                          />
                                        ))}
                                      </Stack>
                                    ))}
                                    {g.semiList.length > lineRenderCap && (
                                      <Typography variant="caption" color="text.secondary">
                                        …외 반자동 {g.semiList.length - lineRenderCap}줄
                                      </Typography>
                                    )}
                                  </Stack>
                                </Box>
                              </Box>
                            );
                          })}
                        </Stack>
                      </Box>
                      {groups.length > groupShowLimit && (
                        <Button
                          type="button"
                          size="small"
                          variant="text"
                          onClick={() => setGroupShowLimit((v) => v + (IS_CONSTRAINED_DEVICE ? 10 : 60))}
                          sx={{ mt: 0.25 }}
                        >
                          더 보기 (+{Math.min(IS_CONSTRAINED_DEVICE ? 10 : 60, groups.length - groupShowLimit)} · 남은 {groups.length - groupShowLimit}건)
                        </Button>
                      )}
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
                          size={ENGINE_BALL.list}
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

      {/* 누적 패턴 · 회차별 용지 데이터 — ② 끝(1:1 뒤). 분석 본문과 분리된 데이터 층. */}
      {analysisEpilogue}
        </>
        )}
      </Paper>

      {/* ════════ ③ 번호 추천 (기본 펼침 · 추천 상세는 항상 표시) ════════ */}
      <Paper id="photo-section-recommend" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 1 }} spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={800}>
            ③ 번호 추천
          </Typography>
          <Chip size="small" color={compareWinning ? 'primary' : 'secondary'} label={intentSectionLabel} sx={{ height: 22, fontWeight: 700 }} />
          <Chip
            size="small"
            variant="outlined"
            label="학습 엔진 → ④"
            onClick={() => {
              setShowPredictionDetail(true);
              setEngineTab('learn');
            }}
            sx={{ height: 22, cursor: 'pointer' }}
          />
        </Stack>
        <Button size="small" variant="outlined" onClick={() => setShowRecommendSection((v) => !v)}>
          {showRecommendSection ? '접기 ▲' : '펼치기 ▼'}
        </Button>
      </Stack>
      <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Chip
          size="small"
          variant="outlined"
          label="핵심"
          onClick={() => {
            setShowRecommendSection(true);
            document.getElementById('photo-rec-hero')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
        />
        <Chip
          size="small"
          variant="outlined"
          label="5세트"
          onClick={() => {
            setShowRecommendSection(true);
            document.getElementById('photo-rec-sets')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
        />
        {!compareWinning && (
          <Chip
            size="small"
            variant="outlined"
            color="secondary"
            label="반자동검증"
            onClick={() => {
              setShowRecommendSection(true);
              window.setTimeout(() => {
                document.getElementById('photo-rec-semi')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 40);
            }}
            sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
          />
        )}
        <Chip
          size="small"
          variant="outlined"
          label="종합분석"
          onClick={() => {
            setShowCompositeEmbed(true);
            window.setTimeout(() => scrollToPhotoRecommend({ embed: 'composite' }), 60);
          }}
          sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
        />
        <Chip
          size="small"
          variant="outlined"
          label="호기 → ④"
          onClick={() => {
            setShowPredictionDetail(true);
            setEngineTab('aux');
            window.setTimeout(() => {
              const el =
                document.getElementById('engine-machine-patterns')
                ?? document.getElementById('engine-machine-overview');
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 80);
          }}
          sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
        />
        <Chip
          size="small"
          variant="outlined"
          color="info"
          label="검증 WF → ④"
          onClick={() => {
            setShowPredictionDetail(true);
            setEngineTab('verify');
            window.setTimeout(() => {
              document.getElementById('engine-verify-wf')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 80);
          }}
          sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
        />
      </Stack>
      {!showRecommendSection && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          핵심 · 용지 5세트 · 강수/기대 · 종합예측 — 접힘. 합의/Venus는 아래 토글. 호기 패턴·현황·백테스트는 ④.
        </Typography>
      )}
      {showRecommendSection && (
      <>
      {/* 🎯 핵심 추천 — 복기는 서버 검증 확정 전 로딩(임시 로컬을 검증으로 위장하지 않음) */}
      {compareWinning && heroRecommendation.pending && (
        <Paper id="photo-rec-hero" variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'warning.main', borderWidth: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            <Typography variant="body1" fontWeight={800}>
              {recommendHeroTitle}
            </Typography>
            <Chip size="small" color="warning" label="검증 대기" sx={{ height: 20, fontSize: 10, fontWeight: 700 }} />
          </Stack>
          <LinearProgress sx={{ mb: 1 }} />
          <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
            <Typography variant="caption">
              {heroRecommendation.pendingReason || '복기 검증 API 계산 중…'}
              {' '}데이터 불러오기 전의 로컬 순위는 검증 추천이 아니며, 당첨 대조 전·후 세트가 바뀌어 보이는 착시를 막기 위해 숨깁니다.
            </Typography>
          </Alert>
        </Paper>
      )}
      {heroRecommendation.ready && (
        <Paper id="photo-rec-hero" variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'warning.main', borderWidth: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Typography variant="body1" fontWeight={800}>
                {compareWinning && heroRecommendation.serverRound != null
                  ? `🎯 복기 ${heroRecommendation.serverRound}회 검증 추천`
                  : recommendHeroTitle}
              </Typography>
              <Chip
                size="small"
                color={compareWinning ? 'primary' : 'secondary'}
                label={
                  compareWinning
                    ? `복기 ${heroRecommendation.serverRound ?? effectiveRound ?? '?'}회`
                    : `이번회차 ${currentRound ?? '?'}회`
                }
                sx={{ height: 20, fontSize: 10, fontWeight: 700 }}
              />
              {heroRecommendation.sourceLabel && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={heroRecommendation.verified ? 'success' : 'default'}
                  label={heroRecommendation.sourceLabel}
                  sx={{ height: 20, fontSize: 10, fontWeight: 700 }}
                />
              )}
            </Stack>
            <Chip
              size="small"
              variant="outlined"
              color="success"
              label={compareWinning ? '④ 엔진 · 복기 용지' : '④ 엔진 · 이번회차 용지'}
              sx={{ height: 20, fontSize: 10, fontWeight: 700 }}
            />
          </Stack>
          {heroRecommendation.contrastPending && (
            <Alert severity="warning" icon={false} sx={{ py: 0.5, mb: 1 }}>
              <Typography variant="caption">
                당첨번호 로딩 중 — 공 색은 아직 대조하지 않습니다(전부 밝게 보이는 상태는 당첨이 아닙니다).
              </Typography>
            </Alert>
          )}
          {heroRecommendation.reviewRounds > 0 && (
            <Alert severity="success" icon={false} sx={{ py: 0.5, mb: 1 }}>
              <Typography variant="caption">
                ✅ <strong>복기 {heroRecommendation.reviewRounds}회차 검증 완료</strong>
                {compareWinning && (heroRecommendation.serverRound ?? effectiveRound) != null
                  ? ` (이 추천 = ${heroRecommendation.serverRound ?? effectiveRound}회)`
                  : ''}
                {!compareWinning && currentRound != null ? ` → 적용 대상 ${currentRound}회` : ''}
                {' '}— 당첨을 가장 잘 잡은 신호는{' '}
                <strong>{heroRecommendation.signalLabel}</strong>
                {heroRecommendation.selectedBy === 'loo_held'
                  ? '(LOO)'
                  : heroRecommendation.selectedByMulti
                    ? '(다회차 1위)'
                    : ''}
                {heroRecommendation.bestTop18 != null
                  ? `, 신호 상위18 평균 ${heroRecommendation.bestTop18}/6 · 확장망 top${heroRecommendation.expandSize}`
                  : ` · 확장망 top${heroRecommendation.expandSize}`}
                .{' '}→ {recommendHeroHint}
                {heroRecommendation.goodSignalCount > 0
                  ? ` 아래 핵심 6은 검증 통과 신호 ${heroRecommendation.goodSignalCount}개가 함께 가리킨 합의입니다(공에 '몇 신호').`
                  : ` 아래 핵심 6은 다회차 1위 신호(${heroRecommendation.signalLabel}) 상위6입니다 — 여러 신호를 '합의'로 섞으면 약한 신호가 최고 신호를 희석해 오히려 덜 잡습니다(앙상블 백테스트로 실증).`}{' '}
                <strong>top-6 집중보다 넓은 그물이 유효</strong>.
                {heroRecommendation.coverageMode === 'expand18_first'
                  ? ' 역산 정책: 확장망 우선 주입(집중 실패 보정).'
                  : ''}
                {heroRecommendation.expandModeLabel
                  ? ` 확장망: ${heroRecommendation.expandModeLabel}.`
                  : ''}
                {heroRecommendation.showWinning && heroRecommendation.winsReady
                  ? ` 핵심6 ${heroRecommendation.core6HitCount ?? 0}/6 · 확장${heroRecommendation.expandSize} ${heroRecommendation.expandHitCount ?? 0}/6.`
                  : ''}
                {heroRecommendation.selectedBy === 'loo_held'
                  ? ' 신호=이 회차 제외 LOO(다회차 multi가 이 용지와 어긋나 로컬 1:1보다 못 잡던 회귀 보정).'
                  : ''}
                {heroRecommendation.pairDiag
                  ? ` 1:1곱 패리티 참고: 핵심6 ${heroRecommendation.pairDiag.core6Count}/6 · 확장24 ${heroRecommendation.pairDiag.expandCount}/6.`
                  : ''}
                {heroRecommendation.sheetMeta ? ` (${heroRecommendation.sheetMeta})` : ''}
              </Typography>
            </Alert>
          )}
          {heroRecommendation.showWinning && heroRecommendation.winsReady && heroRecommendation.outsideExpand.length > 0 && (
            <Stack spacing={0.35} sx={{ mb: 0.75 }}>
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="caption" fontWeight={800} color="warning.main" sx={{ minWidth: 58 }}>
                  확장망 밖
                </Typography>
                {heroRecommendation.outsideExpand.map((n) => (
                  <LottoBall key={`hero-out-${n}`} number={n} size={ENGINE_BALL.list} />
                ))}
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                  용지에는 있으나 확장 {heroRecommendation.expandSize} 순위 밖 (엔진 순위 한계)
                </Typography>
              </Stack>
              {heroRecommendation.missedDetail.length > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, pl: 7.5 }}>
                  {heroRecommendation.missedDetail.map((m) => {
                    const ranks = [
                      m.boe_rank != null ? `합산 ${m.boe_rank}위` : null,
                      m.single_rank != null ? `단일 ${m.single_rank}위` : null,
                    ].filter(Boolean).join(' · ');
                    return `${m.number}${ranks ? `(${ranks})` : ''}`;
                  }).join(' · ')}
                </Typography>
              )}
            </Stack>
          )}
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            <Typography variant="caption" fontWeight={800} sx={{ minWidth: 58 }}>핵심 6</Typography>
            {heroRecommendation.core6.map((n) => {
              const isWin = Boolean(heroRecommendation.winsReady && winningSet?.has(n));
              // 당첨 미로드: 전부 dim — 전부 밝음 = 당첨처럼 보이는 착시 방지
              const dimmed = heroRecommendation.contrastPending
                || Boolean(heroRecommendation.winsReady && !isWin);
              return (
                <Box key={`hero-c-${n}`} sx={{ textAlign: 'center', minWidth: 30 }}>
                  <LottoBall
                    number={n}
                    size={ENGINE_BALL.hero}
                    dimmed={dimmed}
                  />
                  {heroRecommendation.agreement[String(n)] != null && (
                    <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1, color: 'text.disabled' }}>
                      {heroRecommendation.agreement[String(n)]}신호
                    </Typography>
                  )}
                </Box>
              );
            })}
            <SharingBadge numbers={heroRecommendation.core6} />
            <ComboActions numbers={heroRecommendation.core6} source="unknown" label="핵심6 추천" />
          </Stack>
          {heroRecommendation.shareOpt.length === 6 && (
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
              <Typography variant="caption" fontWeight={800} sx={{ minWidth: 58 }}>분산 최적</Typography>
              {heroRecommendation.shareOpt.map((n) => (
                <LottoBall
                  key={`hero-s-${n}`}
                  number={n}
                  size={ENGINE_BALL.list}
                  dimmed={
                    heroRecommendation.contrastPending
                    || Boolean(heroRecommendation.winsReady && winningSet && !winningSet.has(n))
                  }
                />
              ))}
              <SharingBadge numbers={heroRecommendation.shareOpt} />
              <ComboActions numbers={heroRecommendation.shareOpt} source="unknown" label="분산최적 추천" />
            </Stack>
          )}
          <Stack direction="row" spacing={0.3} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" fontWeight={800} sx={{ minWidth: 58 }}>
              확장 {heroRecommendation.expandSize}
            </Typography>
            {heroRecommendation.expand18.map((n) => (
              <LottoBall
                key={`hero-e-${n}`}
                number={n}
                size={ENGINE_BALL.list}
                dimmed={
                  heroRecommendation.contrastPending
                  || Boolean(heroRecommendation.winsReady && winningSet && !winningSet.has(n))
                }
              />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5, mt: 0.75, fontStyle: 'italic' }}>
            {compareWinning && heroRecommendation.winsReady
              ? `밝은 공 = ${heroRecommendation.serverRound ?? effectiveRound ?? '?'}회 실제 당첨 · 회색 = 비당첨. `
              : compareWinning
                ? '복기 탭: 당첨번호 로딩 후 밝은 공/회색으로 대조합니다(로딩 중 회색 = 미대조). '
                : '이번회차 탭: 미추첨이라 당첨 대조 없음. '}
            핵심 6 = 집중 픽 · 확장 {heroRecommendation.expandSize} = 넓은 그물 · 분산 최적 = 공동당첨 회피.
            {' '}아래: 용지 통계 5세트 → 강수·기대·종합 예측. 역산·학습·검증은 <strong>④ 엔진</strong>.
          </Typography>
        </Paper>
      )}


        {/* 🎲 용지 통계 종합 추천 — ③ 번호 추천 */}
        <Paper id="photo-rec-sets" variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }} spacing={1}>
            <Typography variant="body2" fontWeight={700}>
              🎲 용지 통계 종합 추천 조합{compareWinning ? ' (복기 검증)' : ` (${currentRound ?? effectiveRound ?? '?'}회 예상)`}
            </Typography>
            <Button
              type="button"
              size="small"
              variant="contained"
              color="success"
              onClick={generateRecommendations}
              disabled={
                combinedTickets.length === 0 &&
                parallelStrong.length === 0 &&
                machineStrong.length === 0
              }
            >
              추천 5세트 생성
            </Button>
          </Stack>
          {compareWinning && (
            <Alert severity="info" sx={{ mb: 1, py: 0.5 }} icon={false}>
              <Typography variant="caption">
                <strong>당첨 적중이 자료 로드 후 낮아 보이는 이유:</strong> 1등 확률(1/8,145,060)은
                변하지 않습니다. 복기 당첨번호를 불러오기 <em>전</em>에는 대조가 없어 공이 모두 밝게
                보이고, 불러온 <em>뒤</em>에는 실제 당첨과 맞춰 회색·당첨 N/6이 표시됩니다(착시 해소).
                또한 복기 탭은 forward 학습 주입 OFF(validatedLearning{' '}
                {learningBridgeStatus.validatedCount}개)라 이번회차보다 보수적으로 조합이 잡힙니다.
              </Typography>
            </Alert>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            <strong>주입 경로:</strong> 1:1 전수비교 · 평행(엔진② 직접) · 프로파일 매칭(L2) ·
            validatedLearning <strong>{learningBridgeStatus.validatedCount}개</strong>
            (엔진③ Feature/Pattern/다회차/겹침/커버리지/이월).
            미검증·평탄 제외. 강한후보·호기 추정 미사용.
            {compareWinning
              ? ' 복기: forward 학습 OFF·커버리지·평행만. 당첨 일치는 표시만(점수 미주입).'
              : ' 이번회차: forward 학습 ON.'}
            {/* ⚠️ combinedTickets 만 보면 '반자동만 있는' 상태에서도 '분석 대상 N줄'
                이라고 표시돼, 1:1 축과 학습 프로파일 축이 죽은 사실이 감춰진다.
                실제로 3축이 살아있는지는 canRenderLineMatching(자동>0 && 반자동>0)로 판정. */}
            {combinedTickets.length === 0
              ? (parallelStrong.length > 0
                  ? ' ※ 입력 줄이 없어 평행회차 신호만으로 생성합니다.'
                  : ' ※ [재분석]으로 평행회차 신호를 먼저 불러오세요.')
              : !canRenderLineMatching
                ? ` ⚠️ 자동 ${groupLineMatching.autoLineCount}줄 · 반자동 ${groupLineMatching.semiLineCount}줄 — 한쪽이 비어 1:1 전수비교와 학습 프로파일 축이 동작하지 않습니다. 현재는 평행회차 신호만 반영됩니다.`
                : ` 분석 대상 ${combinedTickets.length}줄 (자동 ${groupLineMatching.autoLineCount}·반자동 ${groupLineMatching.semiLineCount} — 3축 정상).`}
            {' '}정직성: 수학적 당첨 확률(1/8,145,060)은 동일하며, 통계적으로 1등에 거의 없는
            조합(합 극단·전부 홀짝·4연속 등)을 제외합니다.
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
                      <LottoBall
                        key={n}
                        number={n}
                        size={ENGINE_BALL.list}
                        dimmed={Boolean(compareWinning && winningSet && !winningSet.has(n))}
                      />
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

        {/* 반자동 빈도 — 복기 다회차 검증 후 이번회차만 표시(핵심6·5세트 대체 아님) */}
        {!compareWinning && reviewVerificationQuery.data?.ok && reviewVerificationQuery.data.semi_signal_report && (
          <Paper
            id="photo-rec-semi"
            variant="outlined"
            sx={{
              p: 1.5,
              mb: 1.5,
              borderColor: reviewVerificationQuery.data.semi_signal_report.show_in_recommend
                ? 'secondary.main'
                : 'divider',
            }}
          >
            {(() => {
              const sr = reviewVerificationQuery.data!.semi_signal_report!;
              const tops = sr.current_top12 ?? [];
              return (
                <>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }} spacing={1}>
                    <Typography variant="body2" fontWeight={800}>
                      반자동 등장 상위 · 복기 검증
                    </Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Chip
                        size="small"
                        color={sr.show_in_recommend ? 'success' : 'default'}
                        label={sr.verdict ?? (sr.ok ? '집계됨' : '미집계')}
                        sx={{ height: 20, fontSize: 10, fontWeight: 700 }}
                      />
                      {sr.rounds != null && (
                        <Chip size="small" variant="outlined" label={`복기 ${sr.rounds}회`} sx={{ height: 20, fontSize: 10 }} />
                      )}
                    </Stack>
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontSize: 10 }}>
                    보관 복기 회차에서 <strong>반자동 빈도(고정수 제외)</strong> 상위18이 당첨을 평균{' '}
                    {sr.mean_top18 ?? '—'}개 담음(무작위≈{sr.random_top18 ?? 2.4}
                    {sr.significance?.p_value != null ? ` · p=${sr.significance.p_value}` : ''}
                    {sr.small_sample ? ' · 소표본' : ''}).
                    {' '}이번회차 반자동 {sr.current_semi_line_count ?? 0}줄 기준 상위 표시.
                    핵심6·용지 5세트를 대체하지 않으며 1등 확률은 불변입니다.
                  </Typography>
                  {tops.length > 0 ? (
                    <Stack direction="row" spacing={0.4} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" fontWeight={800} sx={{ minWidth: 58 }}>상위 {tops.length}</Typography>
                      {tops.map((n) => (
                        <LottoBall key={`semi-top-${n}`} number={n} size={ENGINE_BALL.list} />
                      ))}
                      {tops.length >= 6 && (
                        <ComboActions
                          numbers={[...tops].slice(0, 6).sort((a, b) => a - b)}
                          source="unknown"
                          label="반자동 상위6 참고"
                        />
                      )}
                    </Stack>
                  ) : (
                    <Alert severity="info" sx={{ py: 0.5 }} icon={false}>
                      <Typography variant="caption">
                        이번회차 반자동 줄이 없거나 고정수만 있어 상위 번호를 못 만들었습니다.
                        반자동을 등록·저장한 뒤 다시 확인하세요. 복기 검증 수치({sr.mean_top18 ?? '—'}/6)는 위에 표시됩니다.
                      </Typography>
                    </Alert>
                  )}
                  {(sr.current_fixed_excluded?.length ?? 0) > 0 && (
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9.5, mt: 0.5 }}>
                      고정수 제외: {sr.current_fixed_excluded!.join(', ')}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
                    {sr.honesty ?? '확률 불변 · 커버리지 참고만.'}
                    {' '}상세 신호 순위는 <strong>④ 엔진</strong>.
                  </Typography>
                </>
              );
            })()}
          </Paper>
        )}

      <Divider textAlign="left" sx={{ mt: 2, mb: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
          <Typography variant="caption" fontWeight={800} color="text.secondary">
            추천 상세 · 강수·기대수 · 종합 예측
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={`${intentSectionLabel} ${effectiveRound ?? '?'}회`}
            sx={{ height: 18, fontSize: 9 }}
          />
        </Stack>
      </Divider>
      {/* 강수·기대수 · 최종합의 — ③ 추천 상세 (1:1 반복도 기반, activeComparison 불필요) */}
      {(decadePattern || finalStrongExpected) && (
        <>
              {/* ★ 1:1 강수 & 기대수 (구간별) — 평행회차와 동일 레이아웃, 1:1 반복도 기반 */}
              {decadePattern && (
                <Box sx={{ mt: 0.5, p: 1.25, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.25 }}>
                    <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" fontWeight={800}>
                        ★ 1:1 강수 &amp; 기대수 (구간별)
                      </Typography>
                      <Chip size="small" variant="outlined" label={`${intentSectionLabel} ${effectiveRound ?? '?'}회 · 전수비교 반복도`} sx={{ height: 18, fontSize: 9 }} />
                    </Stack>
                    {decadePattern.strongWinHit != null && (
                      <Chip
                        size="small"
                        color={decadePattern.strongWinHit >= 4 ? 'success' : decadePattern.strongWinHit >= 2 ? 'warning' : 'default'}
                        label={`강수 ${decadePattern.strongCount}개 중 당첨 ${decadePattern.strongWinHit}개 (무작위 기대≈${Math.round(decadePattern.strongCount * 6 / 45 * 10) / 10}개)`}
                        sx={{ fontWeight: 700, height: 20, fontSize: 10 }}
                      />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
                    강수 = 구간별 1:1 반복도 상위 3 · 기대 = 다음 3. 숫자 아래 = 자동/반자동 등장 줄 수.
                    {compareWinning
                      ? ` 밝은 공 = ${effectiveRound ?? '?'}회 실제 당첨 · 회색 = 비당첨.`
                      : ' 이번회차(미추첨) — 당첨 대조 없음. 반자동 고정수는 강수에서 분리됨.'}
                  </Typography>
                  <Stack spacing={0.5}>
                    {decadePattern.byBand.map((b) => (
                      <Stack key={b.label} direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
                        <Typography variant="caption" fontWeight={700} sx={{ minWidth: 44, fontSize: 10 }}>{b.label}</Typography>
                        <Typography variant="caption" color="error.light" sx={{ fontSize: 10, fontWeight: 700 }}>강수</Typography>
                        {b.strong.length === 0 && <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>—</Typography>}
                        {b.strong.map((s) => (
                          <Box key={`st-${s.number}`} sx={{ textAlign: 'center', minWidth: 26 }}>
                            <LottoBall number={s.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !s.winning : false} />
                            <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1, color: 'text.disabled' }}>
                              {s.auto}/{s.semi}{s.maxMatch >= 3 ? `·${s.maxMatch}일치` : ''}
                            </Typography>
                          </Box>
                        ))}
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, fontWeight: 700, ml: 0.5 }}>기대</Typography>
                        {b.expected.length === 0 && <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>—</Typography>}
                        {b.expected.map((s) => (
                          <Box key={`ex-${s.number}`} sx={{ textAlign: 'center', minWidth: 26 }}>
                            <LottoBall number={s.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !s.winning : false} />
                            <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1, color: 'text.disabled' }}>
                              {s.auto}/{s.semi}
                            </Typography>
                          </Box>
                        ))}
                      </Stack>
                    ))}
                    <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" fontWeight={700} sx={{ minWidth: 44, fontSize: 10 }}>끝수</Typography>
                      {decadePattern.endingTop.map((e) => (
                        <Chip key={`ed-${e.digit}`} size="small" variant="outlined" label={`${e.digit} (${e.count})`} sx={{ height: 18, fontSize: 10 }} />
                      ))}
                    </Stack>
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 0.5 }}>
                    {compareWinning && decadePattern.distribution ? (
                      <>
                        <strong>당첨 분포</strong>: 강수 {decadePattern.distribution.strong}개 · 기대 {decadePattern.distribution.expected}개 ·
                        그외 등장 {decadePattern.distribution.etc}개
                        {decadePattern.distribution.missing > 0
                          ? ` · 티켓 밖 ${decadePattern.distribution.missing}개(용지 분석 한계 — 학습 신호 제외)`
                          : ' · 전부 티켓 안(추출 가능 회차)'}
                      </>
                    ) : (
                      '강수·기대만 표시합니다. 용지 미출현은 학습 엔진 신호에서 제외합니다.'
                    )}
                  </Typography>
                </Box>
              )}

              {/* 🎯 최종 강수·기대수 (구간별 신호 종합) — 반복도 × 검증학습 × 이월 겹침 재정렬 */}
              {finalStrongExpected && (
                <Box sx={{ mt: 1.25, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'warning.main' }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.25 }}>
                    <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" fontWeight={800}>
                        🎯 최종 강수·기대수 (구간별 신호 종합)
                      </Typography>
                      <Chip size="small" variant="outlined" label={`${intentSectionLabel} ${effectiveRound ?? '?'}회`} sx={{ height: 18, fontSize: 9 }} />
                    </Stack>
                    {carryoverQuery.data?.ok && carryoverQuery.data.backtest?.by_k?.['6'] && (
                      <Chip
                        size="small"
                        color={!finalStrongExpected.carryFlat ? 'success' : 'default'}
                        label={`이월 검증 lift ${carryoverQuery.data.backtest.by_k['6'].lift}×(K6)·${carryoverQuery.data.backtest.by_k['12']?.lift ?? '-'}×(K12) — ${finalStrongExpected.carryFlat ? '평탄(참고만)' : '신호 반영'}`}
                        sx={{ height: 20, fontSize: 10, fontWeight: 700 }}
                      />
                    )}
                    {carryoverQuery.data?.ok && carryoverQuery.data.backtest?.by_k?.['12']?.significance && (
                      <Chip
                        size="small"
                        variant="outlined"
                        color={carryoverQuery.data.backtest.by_k['12'].significance!.significant ? 'success' : 'default'}
                        label={`이월 p=${carryoverQuery.data.backtest.by_k['12'].significance!.p_value}${carryoverQuery.data.backtest.by_k['12'].significance!.significant ? ' ✓유의' : carryoverQuery.data.backtest.by_k['12'].significance!.small_sample ? ' ·소표본' : ''}`}
                        sx={{ height: 18, fontSize: 9, fontWeight: 700 }}
                      />
                    )}
                  </Stack>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                    <Chip size="small" variant="outlined" label="🔁 반복(1:1)" sx={{ height: 18, fontSize: 9 }} />
                    <Chip size="small" variant="outlined" label="🧠 검증학습" sx={{ height: 18, fontSize: 9 }} />
                    <Chip size="small" variant="outlined" label="↪ 이월" sx={{ height: 18, fontSize: 9 }} />
                    <Chip size="small" color="warning" variant="outlined" label="2개+ 겹침 = 최종 강수 후보" sx={{ height: 18, fontSize: 9, fontWeight: 700 }} />
                    {compareWinning && (
                      <Chip size="small" color="success" variant="outlined" label={`${effectiveRound ?? '?'}회 당첨 대조`} sx={{ height: 18, fontSize: 9 }} />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
                    위 1:1 반복도를 시작점으로, <strong>검증 학습</strong>·<strong>이월</strong>이 겹치는 번호를 구간별로 위로 재정렬합니다.
                    {compareWinning
                      ? ` 밝은 공 = ${effectiveRound ?? '?'}회 실제 당첨.`
                      : ' 이번회차(미추첨) — 당첨 하이라이트 없음.'}{' '}
                    확률 불변(넓은 합의 표시).
                  </Typography>
                  <Stack spacing={0.5}>
                    {finalStrongExpected.bands.map((b) => (
                      <Stack key={`fse-${b.label}`} direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
                        <Typography variant="caption" fontWeight={700} sx={{ minWidth: 44, fontSize: 10 }}>{b.label}</Typography>
                        <Typography variant="caption" color="error.light" sx={{ fontSize: 10, fontWeight: 700 }}>강수</Typography>
                        {b.strong.length === 0 && <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>—</Typography>}
                        {b.strong.map((s) => (
                          <Box key={`fss-${s.number}`} sx={{ textAlign: 'center', minWidth: 30 }}>
                            <LottoBall number={s.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !s.winning : false} />
                            <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1.1, color: s.agreement >= 2 ? 'warning.light' : 'text.disabled', fontWeight: s.agreement >= 2 ? 700 : 400 }}>
                              {s.glyphs}
                            </Typography>
                          </Box>
                        ))}
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, fontWeight: 700, ml: 0.5 }}>기대</Typography>
                        {b.expected.length === 0 && <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>—</Typography>}
                        {b.expected.map((s) => (
                          <Box key={`fse2-${s.number}`} sx={{ textAlign: 'center', minWidth: 30 }}>
                            <LottoBall number={s.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !s.winning : false} />
                            <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1.1, color: 'text.disabled' }}>
                              {s.glyphs}
                            </Typography>
                          </Box>
                        ))}
                      </Stack>
                    ))}
                  </Stack>
                  {(() => {
                    const multi = finalStrongExpected.consensus.filter((c) => c.agreement >= 2).slice(0, 8);
                    if (multi.length === 0) {
                      return (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
                          지금은 반복도 외 신호(학습·이월)와 겹치는 번호가 없습니다 — 3개 회차로는 정상. 회차가 쌓이면 합의가 늘어납니다.
                        </Typography>
                      );
                    }
                    return (
                      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.75, p: 0.5, borderRadius: 0.5, bgcolor: 'action.hover' }}>
                        <Typography variant="caption" fontWeight={700} sx={{ fontSize: 10, color: 'warning.light' }}>⭐ 2개+ 신호 합의:</Typography>
                        {multi.map((c) => (
                          <Box key={`cons-${c.number}`} sx={{ textAlign: 'center', minWidth: 30 }}>
                            <LottoBall number={c.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !c.winning : false} />
                            <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1.1, color: 'text.disabled' }}>
                              {c.glyphs}
                            </Typography>
                          </Box>
                        ))}
                        {finalStrongExpected.winHit && (
                          <Chip
                            size="small"
                            color={finalStrongExpected.winHit.multi >= 2 ? 'success' : finalStrongExpected.winHit.multi >= 1 ? 'warning' : 'default'}
                            label={`합의 ${finalStrongExpected.winHit.multiTotal}개 중 당첨 ${finalStrongExpected.winHit.multi}개`}
                            sx={{ height: 18, fontSize: 9, fontWeight: 700 }}
                          />
                        )}
                      </Stack>
                    );
                  })()}
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
                    ⚠️ {carryoverQuery.data?.honesty ?? '이월·학습 신호는 무작위 대비 재현될 때만 순위에 가산되고, 평탄이면 배지(참고)로만 표시합니다. 1등 확률은 불변.'}
                  </Typography>
                </Box>
              )}
        </>
      )}

      {/* 🧪 강수·기대 엔진 접목 — 서버 API(graft-v2) + LOO 백테스트 */}
      {graftCoverageEV?.pending && (
        <Paper variant="outlined" sx={{ p: 1.5, mt: 2, mb: 1.5, borderColor: 'info.main', borderWidth: 2 }}>
          <Typography variant="body2" fontWeight={800} sx={{ mb: 1 }}>🧪 강수·기대 엔진 접목 — 커버리지 · EV</Typography>
          <LinearProgress sx={{ mb: 1 }} />
          <Typography variant="caption" color="text.secondary">
            서버 접목 API 계산 중… (1:1 곱 · 구간커버 · recall-EV · LOO 백테스트)
          </Typography>
        </Paper>
      )}
      {graftCoverageEV && !graftCoverageEV.pending && graftCoverageEV.core6.length >= 6 && (
        <Paper id="photo-rec-graft" variant="outlined" sx={{ p: 1.5, mt: 2, mb: 1.5, borderColor: 'info.main', borderWidth: 2 }}>
          <Stack direction="row" alignItems="center" flexWrap="wrap" useFlexGap spacing={0.75} sx={{ mb: 0.5 }}>
            <Typography variant="body2" fontWeight={800}>🧪 강수·기대 엔진 접목 — 커버리지 · EV</Typography>
            <Chip size="small" color="warning" variant="outlined" label="확률 불변 · recall/EV만" sx={{ height: 18, fontSize: 9, fontWeight: 700 }} />
            <Chip
              size="small"
              color={compareWinning ? 'primary' : 'secondary'}
              label={compareWinning ? `복기 ${effectiveRound ?? '?'}회` : `이번회차 ${currentRound ?? '?'}회`}
              sx={{ height: 18, fontSize: 9, fontWeight: 700 }}
            />
            <Chip
              size="small"
              color={graftCoverageEV.fromApi ? 'success' : 'default'}
              variant="outlined"
              label={graftCoverageEV.graftBuild ?? 'local'}
              sx={{ height: 18, fontSize: 9, fontWeight: 700 }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {graftCoverageEV.dataUsed?.signal_label ?? '1:1 곱'} → {graftCoverageEV.dataUsed?.core_mode_label ?? '구간커버 핵심'}
            {' · '}{graftCoverageEV.dataUsed?.ev_mode_label ?? 'recall-EV'}.
            {' '}확률(1/8,145,060) 불변. {graftCoverageEV.dataUsed?.note ?? ''}
          </Typography>

          {graftCoverageEV.dataUsed && (
            <Alert severity="info" icon={false} sx={{ py: 0.5, mb: 1 }}>
              <Typography variant="caption" component="div">
                <strong>사용 데이터</strong>:{' '}
                용지 {graftCoverageEV.dataUsed.sheet_source ?? '?'} · 자동 {graftCoverageEV.dataUsed.auto_line_count ?? '?'}줄 · 반자동{' '}
                {graftCoverageEV.dataUsed.semi_line_count ?? '?'}줄
                {(graftCoverageEV.dataUsed.fixed_semi_excluded?.length ?? 0) > 0
                  ? ` · 고정수 제외 ${graftCoverageEV.dataUsed.fixed_semi_excluded!.join(',')}`
                  : ''}
                {' · '}신호 {graftCoverageEV.dataUsed.signal ?? 'pair_product'}
                {' · '}출처 {graftCoverageEV.fromApi ? '서버 API' : '로컬 폴백'}
              </Typography>
            </Alert>
          )}

          {graftCoverageEV.backtest?.ok && (
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', mb: 1 }}>
              <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>
                📊 LOO 백테스트 (보관 {graftCoverageEV.backtest.rounds ?? '?'}회 · 누수 없음
                {graftCoverageEV.backtest.small_sample ? ' · 소표본' : ''})
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                {Object.entries(graftCoverageEV.backtest.means ?? {}).map(([k, v]) => (
                  <Chip
                    key={k}
                    size="small"
                    color={k === 'expand24' || k === 'decade_core6' || k === 'recall_ev6' ? 'success' : 'default'}
                    variant={k.startsWith('raw') || k.startsWith('pure') ? 'outlined' : 'filled'}
                    label={`${k} ${v}/6`}
                    sx={{ height: 20, fontSize: 10 }}
                  />
                ))}
              </Stack>
              {(graftCoverageEV.backtest.advice ?? []).map((a) => (
                <Typography key={a.slice(0, 24)} variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5 }}>
                  → {a}
                </Typography>
              ))}
            </Box>
          )}

          {(graftCoverageEV.decadeDropped?.length ?? 0) > 0 && (
            <Alert severity="warning" icon={false} sx={{ py: 0.5, mb: 0.75 }}>
              <Typography variant="caption">
                구간커버가 raw 핵심 당첨을 뺐던 번호:{' '}
                {graftCoverageEV.decadeDropped!.join(', ')}
                {graftCoverageEV.reviewHit
                  ? ` (참고: raw ${graftCoverageEV.reviewHit.rawTop6}/6 · 구간커버는 비교용)`
                  : ''}
                {' — 기본 핵심은 raw 1:1 top6 유지'}
              </Typography>
            </Alert>
          )}
          {graftCoverageEV.outsideCoreInExpand.length > 0 && (
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
              <Typography variant="caption" fontWeight={800} color="warning.main" sx={{ minWidth: 72 }}>
                핵심 밖·확장 안
              </Typography>
              {graftCoverageEV.outsideCoreInExpand.map((n) => (
                <LottoBall key={`gce-out-c-${n}`} number={n} size={ENGINE_BALL.list} />
              ))}
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                1:1 top6 밖이지만 확장24 안 (넓은 그물 본령)
              </Typography>
            </Stack>
          )}

          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
            접목 핵심 6 ({graftCoverageEV.dataUsed?.core_mode_label ?? 'raw 1:1 top6'} · 양쪽 {graftCoverageEV.bothSideCount}/6)
            {graftCoverageEV.reviewHit ? ` · 당첨 ${graftCoverageEV.reviewHit.core6}/6` : ''}
          </Typography>
          <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 0.75 }}>
            {graftCoverageEV.core6.map((n) => (
              <LottoBall
                key={`gce-c-${n}`}
                number={n}
                size={ENGINE_BALL.list}
                dimmed={Boolean(compareWinning && winningSet && winningSet.size > 0 && !winningSet.has(n))}
              />
            ))}
            <SharingBadge numbers={graftCoverageEV.core6} />
            <ComboActions numbers={graftCoverageEV.core6} source="unknown" label="강수·기대 접목 핵심6" />
          </Stack>

          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
            접목 확장망 {graftCoverageEV.expand.length}개 (넓은 그물)
            {graftCoverageEV.reviewHit ? ` · 당첨 ${graftCoverageEV.reviewHit.expand}/6` : ''}
          </Typography>
          <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            {graftCoverageEV.expand.map((n) => (
              <LottoBall
                key={`gce-e-${n}`}
                number={n}
                size={ENGINE_BALL.table}
                dimmed={Boolean(compareWinning && winningSet && winningSet.size > 0 && !winningSet.has(n))}
              />
            ))}
          </Stack>

          {graftCoverageEV.shareOpt.length >= 6 && (
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
              <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                <Typography variant="caption" fontWeight={700}>
                  💰 recall-EV 6 (상위12≥4 + 공동당첨 회피)
                  {graftCoverageEV.reviewHit ? ` · 당첨 ${graftCoverageEV.reviewHit.share}/6` : ''}
                  {graftCoverageEV.reviewHit?.pureEv != null
                    ? ` · 순수EV ${graftCoverageEV.reviewHit.pureEv}/6`
                    : ''}
                  :
                </Typography>
                {graftCoverageEV.shareOpt.map((n) => (
                  <LottoBall
                    key={`gce-s-${n}`}
                    number={n}
                    size={ENGINE_BALL.list}
                    dimmed={Boolean(compareWinning && winningSet && winningSet.size > 0 && !winningSet.has(n))}
                  />
                ))}
                <SharingBadge numbers={graftCoverageEV.shareOpt} />
                <ComboActions numbers={graftCoverageEV.shareOpt} source="unknown" label="강수·기대 접목 EV" />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 0.5 }}>
                순수 EV는 희소 고번호만 골라 6·11 등 상위를 버림 → 상위12에서 4개 이상 유지. 회색=비당첨.
              </Typography>
            </Box>
          )}

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 0.75, fontStyle: 'italic' }}>
            {graftCoverageEV.honesty
              ?? '⚠️ 소표본이면 통계 유의는 약합니다. 확률 불변 — recall·EV만 보고합니다.'}
          </Typography>
        </Paper>
      )}


      {/* 이번회차 종합 예측 — ③ 추천 상세 (복기 탭에서는 currentRoundForecast=null) */}
      {currentRoundForecast && (
        <Paper variant="outlined" sx={{ p: 1.5, mt: 2, mb: 1.5, borderColor: 'primary.main', borderWidth: 2 }}>
          <Stack direction="row" alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Typography variant="body2" fontWeight={800}>
              🎯 {currentRound ?? effectiveRound ?? '?'}회 이번회차 종합 예측
            </Typography>
            <Chip size="small" color="secondary" label={`이번회차 ${currentRound ?? '?'}회`} sx={{ height: 18, fontSize: 9, fontWeight: 700 }} />
            {Object.entries(currentRoundForecast.signalTiers).map(([k, on]) => (
              <Chip
                key={k}
                size="small"
                variant={on ? 'filled' : 'outlined'}
                color={on ? 'primary' : 'default'}
                label={`${k} ${on ? '✓' : '—'}`}
                sx={{ height: 18, fontSize: 10 }}
              />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            이번회차에서 사용 가능한 신호를 종합했습니다 — <strong>용지 교차검증(자동↔반자동 1:1 × 심층역산)</strong>
            {' '}+ <strong>통합 예측신호(6소스)</strong> + <strong>평행회차</strong>.{' '}
            {currentRoundForecast.hasTickets
              ? '이번회차 용지가 있어 용지 신호가 주 축입니다.'
              : '이번회차 용지가 없어 통계 신호(통합·평행)만 반영됐습니다. 용지를 등록하면 용지 교차검증이 가세합니다.'}
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            {currentRoundForecast.ranked.map((r, i) => (
              <Box key={`crf-${r.number}`} sx={{ textAlign: 'center', minWidth: 40 }}>
                <Typography sx={{ fontSize: 8, color: i < 6 ? 'primary.light' : 'text.disabled', fontWeight: 700, lineHeight: 1 }}>
                  {i + 1}위
                </Typography>
                <LottoBall number={r.number} size={ENGINE_BALL.list} />
                <Typography sx={{ fontSize: 8, color: 'text.disabled', lineHeight: 1.1 }}>{r.pct}%</Typography>
                <Typography sx={{ fontSize: 7.5, color: 'text.disabled', lineHeight: 1 }}>{r.sources.join('·')}</Typography>
              </Box>
            ))}
          </Stack>
          <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
              <Typography variant="caption" fontWeight={700}>대표 조합:</Typography>
              {currentRoundForecast.representative.map((n) => (
                <LottoBall key={`crfr-${n}`} number={n} size={ENGINE_BALL.list} />
              ))}
              <SharingBadge numbers={currentRoundForecast.representative} />
              <ComboActions numbers={currentRoundForecast.representative} source="unknown" label="이번회차 종합 예측" />
            </Stack>
            {currentRoundForecast.shareOpt &&
              currentRoundForecast.shareOpt.numbers.join(',') !==
                currentRoundForecast.representative.join(',') && (
                <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                  <Typography variant="caption" fontWeight={700}>💰 분산 최적:</Typography>
                  {currentRoundForecast.shareOpt.numbers.map((n) => (
                    <LottoBall key={`crfo-${n}`} number={n} size={ENGINE_BALL.list} />
                  ))}
                  <SharingBadge numbers={currentRoundForecast.shareOpt.numbers} />
                  <ComboActions numbers={currentRoundForecast.shareOpt.numbers} source="unknown" label="이번회차 분산 최적" />
                </Stack>
              )}
          </Box>
          <Typography variant="caption" sx={{ display: 'block', mt: 0.75, fontStyle: 'italic', color: 'text.disabled', fontSize: 10 }}>
            ⚠️ 종합은 신호 일관성 도구입니다. 1등 확률(1/8,145,060)은 불변이며, 분산 최적은 당첨 시 공동분배 회피(실수령 기대)만 개선합니다.
          </Typography>
        </Paper>
      )}

      </>
      )}

      {/* ── 종합 합의·Venus(intent별) — 호기 패턴/현황은 ④ 후속·gap ── */}
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, fontSize: 10 }}>
        Venus·합의 상위만(맵·합의5게임 숨김 — 용지 5세트와 중복). 조합은 용지{' '}
        <strong>5세트</strong>. 호기·Walk-Forward는 <strong>④</strong>.
      </Typography>
      <Paper id="photo-embed-composite" variant="outlined" sx={{ p: 1.25 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1}>
          <Typography variant="subtitle2" fontWeight={800} sx={{ fontSize: 13 }}>
            종합 합의 · Venus ({intentSectionLabel})
          </Typography>
          <Button size="small" variant="outlined" onClick={() => setShowCompositeEmbed((v) => !v)}>
            {showCompositeEmbed ? '접기 ▲' : '펼치기 ▼'}
          </Button>
        </Stack>
        {showCompositeEmbed && (
          <Box sx={{ mt: 1 }}>
            <Suspense
              fallback={
                <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1.5 }}>
                  <CircularProgress size={18} />
                  <Typography variant="caption" color="text.secondary">종합 분석 로딩…</Typography>
                </Stack>
              }
            >
              <ComposedAnalysisPage embedded sheetIntent={sheetIntent} />
            </Suspense>
          </Box>
        )}
      </Paper>
      </Paper>

      {/* ════════ ④ 패턴 분석 엔진 (기본 접힘 · 복기검증/백테스트 포함) ════════ */}
      <Box>
        <Button
          fullWidth
          variant="outlined"
          color="inherit"
          onClick={() => setShowPredictionDetail((v) => !v)}
          sx={{ justifyContent: 'space-between', textTransform: 'none', mb: 1 }}
          endIcon={<span>{showPredictionDetail ? '▲' : '▼'}</span>}
        >
          ④ 패턴 분석 엔진 {showPredictionDetail ? '접기' : '펼치기'}
          （용지역산 · 평행 · 검증학습 · 호기·후속 · 검증）
        </Button>
      {showPredictionDetail && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Tabs
            value={engineTab}
            onChange={(_, v) => setEngineTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ mb: 1, minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0.5, textTransform: 'none', fontWeight: 700, fontSize: 12 } }}
          >
            <Tab value="learn" label="학습 레이어" />
            <Tab value="aux" label="호기·후속" />
            <Tab value="verify" label="검증·백테스트" />
          </Tabs>
          {/* 엔진 공통 상태 — 탭과 무관하게 진단 포인트 고정 노출 */}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.25 }}>
            <EngineStatusChip
              color={compareWinning ? 'primary' : 'secondary'}
              label={`${intentSectionLabel} ${effectiveRound ?? '?'}회`}
            />
            <EngineStatusChip
              color={canRenderLineMatching ? 'success' : 'warning'}
              label={canRenderLineMatching ? '1:1 ON' : '1:1 OFF'}
            />
            <EngineStatusChip
              color={learningBridgeStatus.validatedCount > 0 ? 'success' : 'default'}
              label={`학습연동 ${learningBridgeStatus.validatedCount}`}
            />
            <EngineStatusChip
              color={predictionSignals ? 'info' : 'default'}
              label={predictionSignals ? '통합신호 ON' : '통합신호 —'}
            />
          </Stack>
          <Stack spacing={1.5}>
          {engineTab === 'aux' && (
            <>
              <EngineTabBanner
                title={`호기·후속 · ${intentSectionLabel} ${effectiveRound ?? '?'}회`}
                chips={
                  <>
                    <EngineStatusChip
                      variant="outlined"
                      label="호기현황"
                      onClick={() =>
                        document.getElementById('engine-machine-overview')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                      sx={{ cursor: 'pointer' }}
                    />
                    <EngineStatusChip
                      variant="outlined"
                      label="호기패턴"
                      onClick={() =>
                        document.getElementById('engine-machine-patterns')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                      sx={{ cursor: 'pointer' }}
                    />
                  </>
                }
              />
              <MachineOverviewPanel defaultOpen />
              <EngineSection
                id="engine-machine-patterns"
                tone="secondary"
                title="호기 패턴 신호"
                defaultOpen
                intent="다음 회차 호기 실측 신호(참고). ③ 번호추천 점수·용지 5세트에는 넣지 않습니다."
                sx={{ mb: 1.5 }}
              >
                <Suspense
                  fallback={
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1.5 }}>
                      <CircularProgress size={18} />
                      <Typography variant="caption" color="text.secondary">호기 신호 로딩…</Typography>
                    </Stack>
                  }
                >
                  <RoundRecommendPage embedded sheetIntent={sheetIntent} />
                </Suspense>
              </EngineSection>
              <EngineAuxSignalsPanel
                intentLabel={intentSectionLabel}
                roundNo={effectiveRound}
                postOccurrence={predictionSignals?.sources?.post_occurrence ?? null}
                decadeGap={predictionSignals?.sources?.decade_gap ?? null}
              />
            </>
          )}

      {engineTab === 'learn' && (
      <>
      <EngineTabBanner
        title={`학습 레이어 · ${intentSectionLabel} ${effectiveRound ?? '?'}회`}
        chips={
          <>
            <EngineStatusChip
              variant="outlined"
              label="① 1:1·복기"
              onClick={() =>
                document.getElementById('engine-reverse')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              sx={{ cursor: 'pointer' }}
            />
            <EngineStatusChip
              variant="outlined"
              label="② 평행"
              onClick={() =>
                document.getElementById('engine-parallel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              sx={{ cursor: 'pointer' }}
            />
            <EngineStatusChip
              variant="outlined"
              label="③ 검증"
              onClick={() =>
                document.getElementById('engine-validated')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              sx={{ cursor: 'pointer' }}
            />
            <EngineStatusChip
              variant="outlined"
              label="④ 서버신호"
              onClick={() =>
                document.getElementById('engine-signals')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              sx={{ cursor: 'pointer' }}
            />
          </>
        }
      />

      {/* ── 엔진① 1:1·복기 브리지 (L1~L8) ── */}
      <EngineSection
        id="engine-reverse"
        tone="info"
        collapsible
        defaultOpen
        title={`엔진① 1:1·복기 브리지 · ${intentSectionLabel} ${effectiveRound ?? '?'}회`}
        chips={
          <>
            <EngineStatusChip
              color={canRenderLineMatching ? 'success' : 'warning'}
              label={canRenderLineMatching ? '1:1 ON' : '1:1 OFF'}
            />
            <EngineStatusChip
              color={learnedPattern ? 'success' : 'default'}
              label={learnedPattern ? 'L2 패턴' : 'L2 —'}
            />
            <EngineStatusChip
              color={winningPatternAnalysis ? 'success' : 'default'}
              label={winningPatternAnalysis ? 'L3 출현' : 'L3 —'}
            />
            <EngineStatusChip
              color={deepInjectSignals.length > 0 ? 'success' : 'default'}
              label={deepInjectSignals.length > 0 ? `L8→점수 ${deepInjectSignals.length}` : 'L8 —'}
            />
          </>
        }
      >

      <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        {(
          [
            ['learn-l1', 'L1 1:1'],
            ['learn-l2', 'L2 패턴'],
            ['learn-l3', 'L3 출현'],
            ['learn-l4', 'L4 정밀'],
            ['learn-l5', 'L5 강패턴'],
            ['learn-l6', 'L6 레벨'],
            ['learn-l7', 'L7 세트'],
            ['learn-l8', 'L8 심층'],
          ] as const
        ).map(([id, label]) => (
          <EngineStatusChip
            key={id}
            variant="outlined"
            label={label}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            sx={{ cursor: 'pointer' }}
          />
        ))}
      </Stack>
      <Stack spacing={1.25}>
          {!activeComparison && (
            <Alert
              severity={suspendHeavyComparison ? 'warning' : 'info'}
              sx={{ py: 0.5 }}
              action={
                suspendHeavyComparison ? (
                  <Button color="warning" size="small" variant="outlined" onClick={() => setForceDetailedComparison(true)}>
                    전체 전수비교 실행
                  </Button>
                ) : undefined
              }
            >
              <Typography variant="caption">
                {suspendHeavyComparison ? (
                  <>
                    대량 용지로 <strong>1:1 전수비교가 보류</strong>되어 L1·L4~L8 본문이 비어 있습니다.
                    <strong> [전체 전수비교 실행]</strong>으로 엔진 역산을 채우세요. L2 패턴학습은 복기 용지만으로도 표시됩니다.
                  </>
                ) : hasLineMatchingInputs ? (
                  <>
                    1:1 비교 결과가 아직 없습니다. 자동·반자동 줄을 확인하세요. L2는 복기 용지 기준으로 학습합니다.
                  </>
                ) : (
                  <>
                    자동·반자동 용지를 등록하면 L1·L4~L8 1:1 역산이 채워집니다. L2 당첨 패턴 학습은 복기 용지·당첨만으로도 동작합니다.
                  </>
                )}
              </Typography>
            </Alert>
          )}
          <Divider textAlign="left" sx={{ my: 0.25 }}>
            <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ fontSize: 10 }}>
              1:1 코어 · L1
            </Typography>
          </Divider>
          <EngineSection
            tone="warning"
            id="learn-l1"
            nested
            defaultOpen={true}
            title={`L1. ${effectiveRound ?? '?'}회 1:1 예상·교차`}
            collapsible
            chips={
              <>
                <EngineStatusChip
                  color={compareWinning ? 'primary' : 'secondary'}
                  label={compareWinning ? '복기 검증' : '예측'}
                />
                <EngineStatusChip
                  variant="outlined"
                  label={canRenderLineMatching ? '전수비교 심층 역산' : '평행단독'}
                />
                <EngineStatusChip
                  variant="outlined"
                  label={`자동 ${groupLineMatching.autoLineCount}↔반자동 ${groupLineMatching.semiLineCount} · 매치 ${groupLineMatching.groupCount}`}
                />
                {compareWinning && (
                  <EngineStatusChip color="primary" label="밝은 공=당첨 · 회색=비당첨" />
                )}
              </>
            }
            intent="A 1:1 반복도(+세트·평행) → B 교차(×L8 심층·검증학습) → C 조합. 당첨은 계산 미사용."
          >
            {predictedNumbers.length === 0 ? (
              <Alert severity="warning" sx={{ py: 0.5 }}>
                예상번호가 없습니다. 자동·반자동 용지를 등록하거나 1:1 매칭이 가능한지 확인하세요.
              </Alert>
            ) : (
              <Stack spacing={1.25}>
              {fixedSemiNumbers.list.length > 0 && (
                <Alert severity="warning" icon={false} sx={{ py: 0.5 }}>
                  <Typography variant="caption">
                    🔒 <strong>반자동 고정수 {fixedSemiNumbers.list.length}개</strong>
                    {' '}({fixedSemiNumbers.list.slice(0, 12).map((f) => `${f.number}(${Math.round(f.frac * 100)}%)`).join(' · ')}
                    {fixedSemiNumbers.list.length > 12 ? ' …' : ''})
                    — 강수·기대·예상·교차검증에서 분리됨.
                  </Typography>
                </Alert>
              )}
              <EngineSubBlock
                tone="warning"
                title="A. 상위 예상번호 (1:1 반복도)"
                chips={<EngineStatusChip variant="outlined" label={`TOP ${Math.min(10, predictedNumbers.length)}`} />}
              >
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {predictedNumbers.slice(0, 10).map((p, i) => (
                  <Box key={`pred-${p.number}`} sx={{ textAlign: 'center', minWidth: 44 }}>
                    <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1, color: i < 6 ? 'warning.light' : 'text.disabled', fontWeight: 700 }}>
                      {i + 1}위
                    </Typography>
                    <LottoBall
                      number={p.number}
                      size={ENGINE_BALL.list}
                      dimmed={compareWinning && winningSet ? !winningSet.has(p.number) : false}
                    />
                    <Typography variant="caption" sx={{ display: 'block', fontSize: 9, lineHeight: 1.2, color: 'text.secondary', mt: 0.25 }}>
                      {p.sources.join('·')}
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1.1, color: 'text.disabled' }}>
                      {p.confidence}% · 자{p.auto}·반{p.semi}{p.maxMatch >= 3 ? ` · 최대${p.maxMatch}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              </EngineSubBlock>

              {crossValidation && crossValidation.scored.length > 0 && (
                <EngineSubBlock
                  tone="info"
                  title={`B. 교차검증 (1:1 × L8 심층)`}
                  chips={
                    <>
                      <EngineStatusChip variant="outlined" label={`양쪽 ${crossValidation.total}→상위 ${crossValidation.scored.length}`} />
                      <EngineStatusChip
                        color={crossValidation.scored.some((x) => x.validated) ? 'success' : 'default'}
                        label={
                          crossValidation.scored.some((x) => x.validated)
                            ? `검증학습 가산 ${crossValidation.scored.filter((x) => x.validated).length}`
                            : '검증학습 가산 0'
                        }
                      />
                      {compareWinning && crossValidation.backtest ? (
                        <EngineStatusChip
                          color={crossValidation.backtest.top6Hits >= 3 ? 'success' : crossValidation.backtest.top6Hits >= 2 ? 'warning' : 'default'}
                          label={`상위6 ${crossValidation.backtest.top6Hits} · 상위10 ${crossValidation.backtest.top10Hits}`}
                        />
                      ) : null}
                    </>
                  }
                >
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                    <strong>1:1 + 심층역산</strong>이 함께 높은 번호. 양쪽 균형(√기하평균)·최대일치를 더 반영해 순위가 심층과 다를 수 있습니다.
                    {compareWinning ? ` 복기(${effectiveRound ?? '?'})는 실제 당첨과 대조.` : ` ${effectiveRound ?? '?'}회 예측.`}
                  </Typography>
                  {(() => {
                    const boosted = crossValidation.scored.filter((x) => x.validated);
                    if (boosted.length === 0) return (
                      <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'text.disabled', fontSize: 10 }}>
                        🧠 이 순위에 가산된 검증 학습 없음 — 3개 회차로는 Feature/Pattern 채택이 거의 0이라 정상(회차 쌓이면 반영). 지금은 순수 전수비교 × 심층역산.
                      </Typography>
                    );
                    return (
                      <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'info.main', fontSize: 10, fontWeight: 700 }}>
                        🧠 표시된 상위 중 {boosted.length}개에 검증 학습 가산 반영: {boosted.map((x) => x.number).join('·')}
                        {' '}(🧠 표시 · 소스칩에 엔진 표기)
                      </Typography>
                    );
                  })()}
                  <Stack spacing={0.4}>
                    {crossValidation.scored.map((x, i) => (
                      <Stack
                        key={`cv-${x.number}`}
                        direction="row"
                        spacing={0.75}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                        sx={{ p: 0.5, borderRadius: 0.5, bgcolor: x.won ? 'rgba(46,125,50,0.18)' : 'transparent' }}
                      >
                        <Typography sx={{ fontSize: 10, color: 'text.disabled', minWidth: 22, fontWeight: 700 }}>{i + 1}위</Typography>
                        <LottoBall number={x.number} size={ENGINE_BALL.list} dimmed={compareWinning && x.won === false} />
                        {x.won === true && <EngineStatusChip color="success" label="당첨" />}
                        {x.validated && <EngineStatusChip color="info" label="검증학습" />}
                        <Typography variant="caption" sx={{ fontSize: 10.5 }}>
                          교차 {x.cross} · 심층 {x.deep}% · <strong>자동 {x.auto}줄 · 반자동 {x.semi}줄</strong>
                          {x.maxMatch >= 3 ? ` · 최대일치 ${x.maxMatch}` : ''} · {x.sources.join('·')}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                  <Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontStyle: 'italic', color: 'text.disabled', fontSize: 10 }}>
                    ⚠️ {compareWinning ? '복기 같은 회차 대조는 낙관적(일관성 확인용).' : '표본이 적으면 참고용.'}
                  </Typography>
                </EngineSubBlock>
              )}

              <EngineSubBlock
                tone="success"
                title="C. 조합 · 적중 요약"
                chips={<EngineStatusChip variant="outlined" label="구간 균형 6개" />}
              >
              {(() => {
                const decadeOf = (n: number) => Math.min(4, Math.floor((n - 1) / 10));
                const pick: number[] = [];
                const dc: Record<number, number> = {};
                const ticketPresent = predictedNumbers.filter((p) => p.auto + p.semi > 0);
                const fillPool = [
                  ...ticketPresent,
                  ...predictedNumbers.filter((p) => p.auto + p.semi === 0),
                ];
                for (const p of ticketPresent) {
                  if (pick.length >= 6) break;
                  const d = decadeOf(p.number);
                  if ((dc[d] ?? 0) >= 2) continue;
                  pick.push(p.number);
                  dc[d] = (dc[d] ?? 0) + 1;
                }
                for (const p of fillPool) {
                  if (pick.length >= 6) break;
                  if (!pick.includes(p.number)) pick.push(p.number);
                }
                if (pick.length < 6) {
                  return (
                    <Typography variant="caption" color="text.disabled">
                      조합 6개를 만들 후보가 부족합니다.
                    </Typography>
                  );
                }
                pick.sort((a, b) => a - b);
                const hit = compareWinning && winningSet ? pick.filter((n) => winningSet.has(n)).length : null;
                return (
                  <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
                    <Typography variant="caption" fontWeight={700} sx={{ fontSize: 10 }}>
                      {compareWinning ? '검증용 조합' : `${effectiveRound ?? '?'}회 예상 조합`}:
                    </Typography>
                    {pick.map((n) => (
                      <LottoBall key={`pk-${n}`} number={n} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !winningSet.has(n) : false} />
                    ))}
                    {hit != null && (
                      <EngineStatusChip color={hit >= 3 ? 'success' : hit >= 2 ? 'warning' : 'default'} label={`당첨 ${hit}/6`} />
                    )}
                  </Stack>
                );
              })()}
              {compareWinning && winningSet && winningSet.size > 0 ? (
                (() => {
                  const top8 = predictedNumbers.slice(0, 8).map((p) => p.number);
                  const top6 = predictedNumbers.slice(0, 6).map((p) => p.number);
                  const hit8 = top8.filter((n) => winningSet.has(n)).length;
                  const hit6 = top6.filter((n) => winningSet.has(n)).length;
                  const cross6 = crossValidation?.backtest?.top6Hits;
                  const cross10 = crossValidation?.backtest?.top10Hits;
                  return (
                    <Stack spacing={0.5}>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                        <EngineStatusChip
                          color={hit6 >= 3 ? 'success' : hit6 >= 2 ? 'warning' : 'default'}
                          label={`반복도 상위6 ${hit6} · 상위8 ${hit8}`}
                        />
                        {cross6 != null && (
                          <EngineStatusChip
                            color={cross6 >= 3 ? 'success' : cross6 >= 2 ? 'warning' : 'default'}
                            label={`교차 상위6 ${cross6} · 상위10 ${cross10}`}
                          />
                        )}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                        반복도 vs 교차 점수 기준이 다름. top-6보다 <strong>커버리지(상위15~18)</strong>가 당첨을 더 잘 담는 경우가 많습니다.
                      </Typography>
                    </Stack>
                  );
                })()
              ) : (
                <Typography variant="caption" color="text.secondary">
                  상위 6~8개 중 6개를 골라 조합하세요.
                </Typography>
              )}
              </EngineSubBlock>
              </Stack>
            )}
          </EngineSection>


              <Divider textAlign="left" sx={{ my: 0.25 }}>
                <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ fontSize: 10 }}>
                  L2 패턴학습 · L3 출현패턴
                </Typography>
              </Divider>

              <EngineSection
                id="learn-l2"
                nested
                tone="info"
                collapsible
                defaultOpen
                title={`L2. ${learnedPattern?.round ?? '복기'}회 당첨 패턴 학습`}
                chips={
                  <>
                    <EngineStatusChip
                      color={learnedPattern ? 'success' : 'default'}
                      label={learnedPattern ? '학습 ON' : '학습 대기'}
                    />
                    <EngineStatusChip
                      color={patternMatched ? 'success' : 'default'}
                      label={
                        compareWinning
                          ? patternMatched?.hit != null
                            ? `적합도 ${patternMatched.hit}/6`
                            : '적합도'
                          : patternMatched
                            ? '적용 TOP10'
                            : '적용 —'
                      }
                    />
                  </>
                }
                intent={
                  <>
                    복기 당첨 6개의 <strong>1:1 프로파일</strong>(빈도·자동/반자동 비중·3+·조합구조)을 학습.
                    {compareWinning ? ' 같은 회차 적합도 확인(낙관적).' : ` → ${effectiveRound ?? '?'}회 적용 순위.`}
                  </>
                }
              >
                <Stack spacing={1.25}>
                  {learnedPattern && learnedPattern.feats.length > 0 ? (
                    <EngineSubBlock
                      tone="success"
                      title="A. 학습 표본 — 당첨 빈도 순위"
                      chips={
                        <>
                          <EngineStatusChip variant="outlined" label={`학습 ${learnedPattern.round ?? '?'}회`} />
                          <EngineStatusChip variant="outlined" label={`전체 ${learnedPattern.totalNums}`} />
                          <EngineStatusChip
                            variant="outlined"
                            label={`합${learnedPattern.structure.sum}/홀${learnedPattern.structure.odd}/구간${learnedPattern.structure.decades}/연속${learnedPattern.structure.consec}`}
                          />
                        </>
                      }
                    >
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
                        복기 용지에서 당첨 6개가 몇 위였는지 — 학습 프로파일의 근거입니다.
                      </Typography>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                        {learnedPattern.feats
                          .slice()
                          .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
                          .map((f) => (
                            <Box key={`feat-${f.number}`} sx={{ textAlign: 'center', minWidth: 40 }}>
                              <LottoBall number={f.number} size={ENGINE_BALL.list} />
                              <Typography sx={{ fontSize: 9, color: 'text.disabled', lineHeight: 1.1 }}>
                                {f.rank != null ? `${f.rank}위` : '미등장'}
                              </Typography>
                            </Box>
                          ))}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9 }}>
                        {learnedPattern.feats.map((f) => `${f.number}=${f.rank ?? '미등장'}위`).join(' · ')}
                      </Typography>
                    </EngineSubBlock>
                  ) : (
                    <Alert severity="info" sx={{ py: 0.5 }}>
                      복기 용지·당첨 6개가 있어야 패턴을 학습합니다.
                    </Alert>
                  )}

                  {learnedPattern && patternMatched ? (
                    <EngineSubBlock
                      tone="secondary"
                      title={compareWinning ? 'B. 적합도 순위 (학습 프로파일 × 현재 1:1)' : 'B. 적용 순위 (학습 프로파일 × 현재 1:1)'}
                      chips={<EngineStatusChip variant="outlined" label="유사도 TOP10" />}
                    >
                      <Stack direction="row" spacing={0.6} flexWrap="wrap" useFlexGap>
                        {patternMatched.list.map((m, i) => (
                          <Box key={`pm-${m.number}`} sx={{ textAlign: 'center', minWidth: 34 }}>
                            <Typography
                              variant="caption"
                              sx={{
                                display: 'block',
                                fontSize: 8,
                                lineHeight: 1,
                                color: i < 6 ? 'info.light' : 'text.disabled',
                                fontWeight: 700,
                              }}
                            >
                              {i + 1}위
                            </Typography>
                            <LottoBall
                              number={m.number}
                              size={ENGINE_BALL.list}
                              dimmed={compareWinning ? !m.winning : false}
                            />
                            <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1.1, color: 'text.disabled' }}>
                              유사 {m.sim}%{m.deep ? '·3+' : ''}
                            </Typography>
                          </Box>
                        ))}
                      </Stack>
                    </EngineSubBlock>
                  ) : learnedPattern ? (
                    <Alert severity="info" sx={{ py: 0.5 }}>
                      현재 탭에 자동·반자동 1:1이 있어야 학습 프로파일을 적용합니다.
                    </Alert>
                  ) : null}

                  {patternMatched?.hit != null && (
                    <EngineSubBlock
                      tone="warning"
                      title="C. 적합도 확인 (복기·낙관적)"
                      chips={
                        <EngineStatusChip
                          color={patternMatched.hit >= 3 ? 'success' : patternMatched.hit >= 2 ? 'warning' : 'default'}
                          label={`상위6 당첨 ${patternMatched.hit}/6`}
                        />
                      }
                    >
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                        {patternMatched.list.slice(0, 6).map((m) => (
                          <LottoBall
                            key={`fit-${m.number}`}
                            number={m.number}
                            size={ENGINE_BALL.list}
                            dimmed={!m.winning}
                          />
                        ))}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                        같은 회차 학습·확인이라 <strong>낙관적</strong>입니다. 진짜 검증은 다음 회차 이월 적중.
                      </Typography>
                    </EngineSubBlock>
                  )}
                </Stack>
              </EngineSection>

              <EngineSection
                id="learn-l3"
                nested
                tone="success"
                collapsible
                defaultOpen
                title={`L3. ${effectiveRound ?? learnedPattern?.round ?? '?'}회 당첨번호 출현 패턴`}
                chips={
                  <>
                    <EngineStatusChip color="success" label="출현 패턴" />
                    {!compareWinning && (
                      <EngineStatusChip variant="outlined" label="복기 탭 전용" />
                    )}
                    {winningPatternAnalysis && (
                      <EngineStatusChip
                        color={winningPatternAnalysis.inTop8 >= 3 ? 'success' : 'warning'}
                        label={`당첨 ${winningPatternAnalysis.appearedCount}/${winningPatternAnalysis.totalWin}`}
                      />
                    )}
                  </>
                }
                intent="실제 당첨이 현재 1:1 반복도에서 몇 위·어느 일치 레벨이었는지(사후 포착력)."
              >
                {!winningPatternAnalysis ? (
                  <Alert severity="info" sx={{ py: 0.5 }}>
                    {compareWinning
                      ? '1:1 또는 당첨 로딩을 확인하세요.'
                      : '이번회차 탭 — 당첨 출현 패턴은 복기 전용입니다.'}
                  </Alert>
                ) : (
                  <Stack spacing={1}>
                    <EngineSubBlock
                      tone="info"
                      title="1:1 반복도에서 당첨 출현"
                      chips={
                        <>
                          <EngineStatusChip
                            color={winningPatternAnalysis.inTop8 >= 3 ? 'success' : 'warning'}
                            label={`상위8 ${winningPatternAnalysis.inTop8} · 상위14 ${winningPatternAnalysis.inTop14}`}
                          />
                          {winningPatternAnalysis.dominantLevel && (
                            <EngineStatusChip
                              variant="outlined"
                              label={`최다 ${winningPatternAnalysis.dominantLevel[0]}일치×${winningPatternAnalysis.dominantLevel[1]}`}
                            />
                          )}
                        </>
                      }
                    >
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
                        전수비교 반복도(전체 {winningPatternAnalysis.totalNumbers}개) 기준. 순위↑(숫자↓) = 반복도가 당첨을 잘 포착.
                      </Typography>
                      <Stack spacing={0.4}>
                        {winningPatternAnalysis.perWinning.map((w) => {
                          const levelStr = [6, 5, 4, 3, 2]
                            .filter((L) => (w.byLevel[L] ?? 0) > 0)
                            .map((L) => `${L}일치×${w.byLevel[L]}`)
                            .join(' · ');
                          return (
                            <Stack
                              key={`win-${w.number}`}
                              direction="row"
                              alignItems="center"
                              spacing={0.75}
                              flexWrap="wrap"
                              useFlexGap
                            >
                              <LottoBall number={w.number} size={ENGINE_BALL.list} />
                              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                                {w.appeared ? (
                                  <>
                                    반복도 <strong>{w.rank}위</strong> · {w.totalGroups}그룹 ({levelStr}) · 자동{' '}
                                    {w.auto}줄·반자동 {w.semi}줄
                                  </>
                                ) : (
                                  '전수비교 매치에 미등장'
                                )}
                              </Typography>
                            </Stack>
                          );
                        })}
                      </Stack>
                      {(winningPatternAnalysis.winPairs.length > 0 ||
                        winningPatternAnalysis.winTriples.length > 0) && (
                        <Typography
                          variant="caption"
                          color="success.light"
                          sx={{ display: 'block', fontSize: 10, mt: 0.5 }}
                        >
                          당첨번호끼리 반복 세트:{' '}
                          {[...winningPatternAnalysis.winPairs, ...winningPatternAnalysis.winTriples]
                            .slice(0, 6)
                            .map((s) => `{${s.numbers.join(',')}}×${s.groupCount}`)
                            .join(' · ')}
                        </Typography>
                      )}
                    </EngineSubBlock>
                  </Stack>
                )}
              </EngineSection>

              <Divider textAlign="left" sx={{ my: 0.25 }}>
                <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ fontSize: 10 }}>
                  L4~L7
                </Typography>
              </Divider>

              {/* L4. 번호별 반복 출현 정밀 역산 */}
              {predictedNumbers.length > 0 && (
                <EngineSection
                  id="learn-l4"
                  nested
                  defaultOpen={false}
                  tone="neutral"
                  title="L4. 번호별 반복 출현 정밀 역산"
                  chips={
                    <>
                      <EngineStatusChip variant="outlined" label="당첨번호 무관" />
                      {compareWinning && (
                        <EngineStatusChip color="primary" label="밝은 공=당첨 · 회색=비당첨" />
                      )}
                    </>
                  }
                  intent="그룹·레벨·동반 출현 상세. 복기·이번회차 동일 로직(계산에 당첨 미사용)."
                  collapsible
                >
                  <Box
                    sx={{
                      maxHeight: 260,
                      overflowY: 'auto',
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      p: 0.75,
                    }}
                  >
                    <Stack spacing={0.5}>
                      {predictedNumbers.slice(0, 14).map((r) => {
                        const levelStr = [6, 5, 4, 3, 2]
                          .filter((L) => (r.byLevel[L] ?? 0) > 0)
                          .map((L) => `${L}일치×${r.byLevel[L]}`)
                          .join(' · ');
                        const isWin = compareWinning && winningSet ? winningSet.has(r.number) : false;
                        return (
                          <Stack key={`rec-${r.number}`} direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
                            <LottoBall
                              number={r.number}
                              size={ENGINE_BALL.list}
                              dimmed={compareWinning && winningSet ? !isWin : false}
                            />
                            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                              <strong>{r.totalGroups}그룹</strong>{levelStr ? ` (${levelStr})` : ''} · 자동 {r.auto}줄·반자동 {r.semi}줄
                              {r.partners.length > 0 ? ` · 동반 ${r.partners.join(',')}` : ''}
                            </Typography>
                          </Stack>
                        );
                      })}
                    </Stack>
                  </Box>
                </EngineSection>
              )}

              {/* L5. 전수비교 강한 패턴 */}
              {topPatterns.length > 0 && (
                <EngineSection
                  id="learn-l5"
                  nested
                  defaultOpen={false}
                  tone="secondary"
                  title="L5. 전수비교 강한 패턴 (현재 1:1)"
                  chips={
                    <>
                      <EngineStatusChip variant="outlined" label="이번 회차 공통 3개+" />
                      <EngineStatusChip variant="outlined" label="≠ V2 Pattern Mining" />
                      {compareWinning && (
                        <EngineStatusChip color="success" label="밝은 공=전부 당첨이었던 패턴" />
                      )}
                    </>
                  }
                  intent="이번 회차 1:1 우연 초과 겹침 그룹. 엔진③ V2 Pattern Mining(다회차 검증)과 다름."
                  collapsible
                >
                  <Box
                    sx={{
                      maxHeight: topPatterns.length > 8 ? 240 : undefined,
                      overflowY: topPatterns.length > 8 ? 'auto' : undefined,
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      p: 0.75,
                    }}
                  >
                    <Stack spacing={0.5}>
                      {topPatterns.map((pt, idx) => (
                        <Stack
                          key={`pat-${idx}`}
                          direction="row"
                          alignItems="center"
                          spacing={0.5}
                          flexWrap="wrap"
                          useFlexGap
                          sx={{
                            bgcolor: pt.allWinning ? 'success.main' : undefined,
                            opacity: pt.allWinning ? 0.95 : 1,
                            borderRadius: 0.5,
                            px: pt.allWinning ? 0.5 : 0,
                          }}
                        >
                          <Chip size="small" variant="outlined" label={`${pt.matchCount}개 공통`} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
                          <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                            {pt.numbers.map((n) => (
                              <LottoBall
                                key={n}
                                number={n}
                                size={ENGINE_BALL.list}
                                dimmed={compareWinning && winningSet ? !winningSet.has(n) : false}
                              />
                            ))}
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                            자동 {pt.autoCount}줄 ↔ 반자동 {pt.semiCount}줄
                            {compareWinning && winningSet && winningSet.size > 0 ? ` · 당첨 ${pt.winHit}/${pt.matchCount}` : ''}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  </Box>
                </EngineSection>
              )}

              {/* L6. 일치 개수별 겹침 역산 */}
              {levelBreakdown.length > 0 && (
                <EngineSection
                  id="learn-l6"
                  nested
                  defaultOpen={false}
                  tone="neutral"
                  title="L6. 일치 개수별 겹침 번호 역산"
                  chips={
                    <>
                      <EngineStatusChip variant="outlined" label="6·5·4·3·2 레벨" />
                      {compareWinning && (
                        <EngineStatusChip color="primary" label="밝은 공=당첨 · 회색=비당첨" />
                      )}
                    </>
                  }
                  intent="숫자 아래 = 해당 레벨 등장 그룹 수."
                  collapsible
                >
                  <Stack spacing={0.75}>
                    {levelBreakdown.map((lv) => (
                      <Box key={`lv-${lv.mc}`}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.25 }}>
                          <strong>{lv.mc}개 일치</strong> — {lv.groupCount}개 그룹
                          {compareWinning && winningSet && winningSet.size > 0
                            ? ` · 당첨번호 ${lv.winHits}개 등장`
                            : ''}
                        </Typography>
                        <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                          {lv.numbers.slice(0, 12).map((x) => (
                            <Box key={x.number} sx={{ textAlign: 'center', minWidth: 26 }}>
                              <LottoBall
                                number={x.number}
                                size={ENGINE_BALL.list}
                                dimmed={compareWinning && winningSet ? !x.winning : false}
                              />
                              <Typography variant="caption" sx={{ display: 'block', fontSize: 8, lineHeight: 1, color: 'text.disabled' }}>
                                {x.groupCount}회
                              </Typography>
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                </EngineSection>
              )}

              {/* L7. 세트 중복 역산 */}
              {(crossSetPatterns.pairs.length > 0 || crossSetPatterns.triples.length > 0) && (
                <EngineSection
                  id="learn-l7"
                  nested
                  defaultOpen={false}
                  tone="secondary"
                  title="L7. 세트 중복 역산 (현재 1:1)"
                  chips={
                    <>
                      <EngineStatusChip variant="outlined" label="이번 회차 매치그룹" />
                      <EngineStatusChip variant="outlined" label="≠ V4 줄겹침" />
                      {compareWinning && (
                        <EngineStatusChip color="success" label="밝은 공=전부 당첨 세트" />
                      )}
                    </>
                  }
                  intent="이번 회차 1:1 일치 그룹 교차에서 반복되는 2·3세트(L1 가산). 엔진③ V4 줄겹침(다회차/복기)과 다름."
                  collapsible
                >
                  {([
                    { label: '2개 세트', items: crossSetPatterns.pairs },
                    { label: '3개 세트', items: crossSetPatterns.triples },
                  ] as const).map(({ label, items }) =>
                    items.length > 0 ? (
                      <Box key={label} sx={{ mb: 0.75 }}>
                        <Typography variant="caption" sx={{ display: 'block', fontSize: 10, fontWeight: 700, mb: 0.25 }}>
                          {label}
                        </Typography>
                        <Stack spacing={0.4}>
                          {items.map((s, idx) => (
                            <Stack
                              key={`${label}-${idx}`}
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                              flexWrap="wrap"
                              useFlexGap
                              sx={{
                                bgcolor: s.winning ? 'success.main' : undefined,
                                opacity: s.winning ? 0.95 : 1,
                                borderRadius: 0.5,
                                px: s.winning ? 0.5 : 0,
                              }}
                            >
                              <Stack direction="row" spacing={0.4}>
                                {s.numbers.map((n) => (
                                  <LottoBall
                                    key={n}
                                    number={n}
                                    size={ENGINE_BALL.list}
                                    dimmed={compareWinning && winningSet ? !winningSet.has(n) : false}
                                  />
                                ))}
                              </Stack>
                              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                                {s.groupCount}개 그룹 반복 · 지지 {s.support}
                                {compareWinning && winningSet && winningSet.size > 0
                                  ? ` · 당첨 ${s.winHit}/${s.numbers.length}`
                                  : ''}
                              </Typography>
                            </Stack>
                          ))}
                        </Stack>
                      </Box>
                    ) : null,
                  )}
                </EngineSection>
              )}

          <Divider textAlign="left" sx={{ my: 0.25 }}>
            <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ fontSize: 10 }}>
              L8 심층 (점수 연결)
            </Typography>
          </Divider>

          {/* L8. 심층 역산 분석 */}
          {deepAnalysis && (
            <EngineSection
              id="learn-l8"
              nested
              defaultOpen={false}
              tone="info"
              title="L8. 심층 역산 분석 (L1-B·③ 연결)"
              chips={
                <>
                  <EngineStatusChip variant="outlined" label="빈도·가중·허브·네트워크" />
                  {deepAnalysis.finalWin != null ? (
                    <EngineStatusChip
                      color={deepAnalysis.finalWin >= 3 ? 'success' : deepAnalysis.finalWin >= 2 ? 'warning' : 'default'}
                      label={`최종픽 당첨 ${deepAnalysis.finalWin}/6`}
                    />
                  ) : (
                    <EngineStatusChip variant="outlined" label="당첨 미대조" />
                  )}
                </>
              }
              intent="일치 가중·공출현 허브·세트 반복·숨은 강수 합성. 당첨번호는 계산 미사용(복기는 밝은 공 대조만)."
              collapsible
            >
              <Stack spacing={1.25}>
              {/* 🎯 최종 예측 조합 (구간 균형) + 구조 서술 — 이 섹션의 결론 */}
              <EngineSubBlock
                tone="warning"
                title="🎯 최종 예측 조합 6개 (핵심 상위 + 구간 10단위 최대 2개 균형)"
                chips={
                  deepAnalysis.finalWin != null ? (
                    <EngineStatusChip
                      color={deepAnalysis.finalWin >= 3 ? 'success' : deepAnalysis.finalWin >= 2 ? 'warning' : 'default'}
                      label={`당첨 ${deepAnalysis.finalWin}/6`}
                    />
                  ) : undefined
                }
              >
                <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.25 }}>
                  {deepAnalysis.finalPick.map((n) => (
                    <LottoBall key={`fp-${n}`} number={n} size={ENGINE_BALL.hero} dimmed={compareWinning && winningSet ? !winningSet.has(n) : false} />
                  ))}
                </Stack>
                {deepAnalysis.reserve.length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                    예비 교체 후보: {deepAnalysis.reserve.join(', ')} · 구간분산(TOP15) {deepAnalysis.decadeDist.map((d) => `${d.label}:${d.count}`).join('·')}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mt: 0.25 }}>
                  <strong>구조</strong>: 중심 허브 <strong>{deepAnalysis.hubRank[0]?.number ?? '-'}</strong>
                  {deepAnalysis.hubRank[0]?.topPartners.length ? `(→${deepAnalysis.hubRank[0].topPartners.slice(0, 3).join('·')})` : ''} 축 ·{' '}
                  핵심세트 {(crossSetPatterns.triples[0]?.numbers ?? crossSetPatterns.pairs[0]?.numbers ?? []).join('·') || '-'} ·{' '}
                  보조 {deepAnalysis.composite.slice(3, 8).map((c) => c.number).join('·')} ·{' '}
                  제외 {deepAnalysis.exclude.map((e) => e.number).join('·') || '-'}
                </Typography>
              </EngineSubBlock>
              {/* ① 핵심 TOP15 */}
              <EngineSubBlock
                tone="info"
                title="A. 핵심번호 TOP15"
                chips={
                  deepAnalysis.winCheck ? (
                    <EngineStatusChip
                      color={deepAnalysis.winCheck.top6 >= 3 ? 'success' : deepAnalysis.winCheck.top6 >= 2 ? 'warning' : 'default'}
                      label={`TOP6 당첨 ${deepAnalysis.winCheck.top6} · TOP15 ${deepAnalysis.winCheck.top15}`}
                    />
                  ) : (
                    <EngineStatusChip variant="outlined" label="빈도0.5·가중0.3·세트0.1·허브0.1" />
                  )
                }
              >
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                  {deepAnalysis.composite.slice(0, 15).map((c, i) => (
                    <Box key={`comp-${c.number}`} sx={{ textAlign: 'center', minWidth: 34 }}>
                      <LottoBall number={c.number} size={ENGINE_BALL.emphasis} dimmed={compareWinning && winningSet ? !c.winning : false} />
                      <Typography variant="caption" sx={{ display: 'block', fontSize: 9, color: 'text.disabled', lineHeight: 1.1 }}>
                        {i + 1}위·{c.score}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                  근거 분해(상위 6): {deepAnalysis.composite.slice(0, 6).map((c) => `${c.number}[빈${c.cFreq}·가${c.cWeight}·세${c.cSet}·허${c.cHub}]`).join(' ')}
                </Typography>
              </EngineSubBlock>

              {/* 백테스트 · 안정성 */}
              <EngineSubBlock
                tone="secondary"
                title="🧪 백테스트 · 안정성"
                chips={
                  deepAnalysis.stability ? (
                    <EngineStatusChip
                      color={deepAnalysis.stability.jaccard >= 50 ? 'success' : deepAnalysis.stability.jaccard >= 30 ? 'warning' : 'default'}
                      label={`안정성 ${deepAnalysis.stability.jaccard}%`}
                    />
                  ) : undefined
                }
              >
                {deepAnalysis.stability && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
                    짝/홀 줄 분할 TOP12 겹침 {deepAnalysis.stability.jaccard}%
                    {deepAnalysis.stability.jaccard >= 50 ? ' — 견고' : deepAnalysis.stability.jaccard >= 30 ? ' — 중간' : ' — 낮음(노이즈 가능)'}
                  </Typography>
                )}
                {deepAnalysis.backtest ? (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.25 }}>
                      당첨 {deepAnalysis.backtest.W}개 대비 TOP-K — lift=적중/기대, p&lt;0.05면 유의(★)
                    </Typography>
                    <Stack direction="row" sx={{ fontSize: 10, fontWeight: 700, color: 'text.secondary', px: 0.5 }}>
                      <Box sx={{ width: 44 }}>랭킹</Box>
                      <Box sx={{ flex: 1, textAlign: 'right' }}>TOP6</Box>
                      <Box sx={{ flex: 1, textAlign: 'right' }}>TOP15</Box>
                    </Stack>
                    {deepAnalysis.backtest.methods.map((m) => {
                      const fmt = (r: { hit: number; exp: number; lift: number; p: number }) =>
                        `${r.hit}/${r.exp}·×${r.lift}·p${r.p}${r.p < 0.05 ? '★' : ''}`;
                      return (
                        <Stack key={`bt-${m.key}`} direction="row" alignItems="center" sx={{ fontSize: 10, px: 0.5, py: 0.15 }}>
                          <Box sx={{ width: 44, fontWeight: 700 }}>{m.key}</Box>
                          <Box sx={{ flex: 1, textAlign: 'right', color: m.k6.p < 0.05 ? 'success.light' : 'text.secondary', fontWeight: m.k6.p < 0.05 ? 700 : 400 }}>{fmt(m.k6)}</Box>
                          <Box sx={{ flex: 1, textAlign: 'right', color: m.k15.p < 0.05 ? 'success.light' : 'text.secondary', fontWeight: m.k15.p < 0.05 ? 700 : 400 }}>{fmt(m.k15)}</Box>
                        </Stack>
                      );
                    })}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5, mt: 0.5 }}>
                      ※ {effectiveRound ?? '?'}회 1회차 검증. 여러 회차에서 lift&gt;1·p&lt;0.05가 꾸준해야 신호입니다.
                    </Typography>
                  </Box>
                ) : (
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                    이번회차는 당첨 미정이라 유의성 검증 불가 — 안정성만 참고. 복기 탭에서 회차별 검증.
                  </Typography>
                )}
              </EngineSubBlock>

              {/* 🔬 번호 추출 역산 */}
              <EngineSubBlock
                tone="warning"
                title={deepAnalysis.isReviewTarget
                  ? `🔬 번호 추출 역산 — ${effectiveRound ?? '?'}회 당첨이 1:1에서 몇 위였나`
                  : '🔬 번호 추출 역산 — 예상번호가 어느 신호로 추출됐나'}
                chips={
                  <EngineStatusChip
                    color={deepAnalysis.extractSummary.inCompTop15 >= Math.ceil(deepAnalysis.extractSummary.total * 0.6) ? 'success' : deepAnalysis.extractSummary.inCompTop15 >= 2 ? 'warning' : 'default'}
                    label={`종합15 ${deepAnalysis.extractSummary.inCompTop15}/${deepAnalysis.extractSummary.total} · 추출가능 ${deepAnalysis.extractSummary.extractable}`}
                  />
                }
              >
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
                  상위 15위 안이면 그 신호로 추출 가능. ★=상위15.
                </Typography>
                <Stack direction="row" sx={{ fontSize: 9, fontWeight: 700, color: 'text.secondary', px: 0.5 }}>
                  <Box sx={{ width: 30 }}>번호</Box>
                  <Box sx={{ width: 52, textAlign: 'right' }}>양쪽빈도</Box>
                  <Box sx={{ width: 44, textAlign: 'right' }}>가중치</Box>
                  <Box sx={{ width: 40, textAlign: 'right' }}>허브</Box>
                  <Box sx={{ width: 40, textAlign: 'right' }}>세트</Box>
                  <Box sx={{ width: 44, textAlign: 'right' }}>종합</Box>
                  <Box sx={{ flex: 1, textAlign: 'right' }}>추출</Box>
                </Stack>
                {deepAnalysis.extraction.map((e) => {
                  const cell = (r: number | null) => (r == null ? '—' : r <= 15 ? `${r}★` : `${r}`);
                  return (
                    <Stack key={`ext-${e.number}`} direction="row" alignItems="center" sx={{ fontSize: 10, px: 0.5, py: 0.15 }}>
                      <Box sx={{ width: 30 }}>
                        <LottoBall number={e.number} size={ENGINE_BALL.table} />
                      </Box>
                      <Box sx={{ width: 52, textAlign: 'right', color: (e.ranks.freq ?? 999) <= 15 ? 'success.light' : 'text.secondary' }}>{cell(e.ranks.freq)}</Box>
                      <Box sx={{ width: 44, textAlign: 'right', color: (e.ranks.weight ?? 999) <= 15 ? 'success.light' : 'text.secondary' }}>{cell(e.ranks.weight)}</Box>
                      <Box sx={{ width: 40, textAlign: 'right', color: (e.ranks.hub ?? 999) <= 15 ? 'success.light' : 'text.secondary' }}>{cell(e.ranks.hub)}</Box>
                      <Box sx={{ width: 40, textAlign: 'right', color: (e.ranks.set ?? 999) <= 15 ? 'success.light' : 'text.secondary' }}>{cell(e.ranks.set)}</Box>
                      <Box sx={{ width: 44, textAlign: 'right', fontWeight: 700, color: (e.ranks.comp ?? 999) <= 15 ? 'success.light' : 'text.secondary' }}>{cell(e.ranks.comp)}</Box>
                      <Box sx={{ flex: 1, textAlign: 'right', fontSize: 9, color: e.extractable ? 'success.light' : 'text.disabled' }}>
                        {e.present ? (e.extractable ? `가능(${e.bestSignal})` : '상위밖') : '미등장'}
                      </Box>
                    </Stack>
                  );
                })}
              </EngineSubBlock>

              {/* ② 허브 */}
              <EngineSubBlock tone="info" title="B. 허브번호 TOP10 (공출현 중심성)">
                <Stack spacing={0.35}>
                  {deepAnalysis.hubRank.slice(0, 10).map((h, i) => (
                    <Stack key={`hub-${h.number}`} direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" sx={{ fontSize: 10, minWidth: 16, color: 'text.disabled' }}>{i + 1}</Typography>
                      <LottoBall number={h.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !h.winning : false} />
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                        연결 {h.degree} · {h.links}개 →{' '}
                        {h.topPartners.map((p) => (
                          <Box component="span" key={p} sx={{ color: compareWinning && winningSet?.has(p) ? 'success.light' : 'inherit', fontWeight: compareWinning && winningSet?.has(p) ? 700 : 400 }}>{p} </Box>
                        ))}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </EngineSubBlock>

              {/* ③ 강한 세트 */}
              <EngineSubBlock
                tone="success"
                title={`C. 가장 강한 세트 (2·3·4번호)${compareWinning ? ' — 밝은 배경: 전부 당첨' : ''}`}
              >
                {([
                  { label: '2번호', items: crossSetPatterns.pairs.slice(0, 4) },
                  { label: '3번호', items: crossSetPatterns.triples.slice(0, 4) },
                  { label: '4번호', items: deepAnalysis.sets4.slice(0, 4) },
                ] as const).map(({ label, items }) =>
                  items.length > 0 ? (
                    <Stack key={label} direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.35 }}>
                      <EngineStatusChip variant="outlined" label={label} sx={{ minWidth: 52 }} />
                      {items.map((s, idx) => (
                        <Box key={`${label}-${idx}`} component="span"
                          sx={{ px: 0.6, py: 0.15, borderRadius: 0.5, bgcolor: s.winning ? 'success.main' : 'background.paper', border: '1px solid', borderColor: 'divider', fontSize: 10 }}>
                          {s.numbers.join('·')} <Box component="span" sx={{ color: 'text.disabled' }}>×{s.groupCount}</Box>
                        </Box>
                      ))}
                    </Stack>
                  ) : null,
                )}
              </EngineSubBlock>

              {/* ④⑤ 공통·숨은 */}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                <EngineSubBlock tone="primary" title="D. 자동·반자동 공통 핵심" sx={{ flex: 1 }}>
                  <Stack direction="row" spacing={0.35} flexWrap="wrap" useFlexGap>
                    {deepAnalysis.both.slice(0, 10).map((n) => (
                      <LottoBall key={`both-${n}`} number={n} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !winningSet.has(n) : false} />
                    ))}
                    {deepAnalysis.both.length === 0 && <Typography variant="caption" color="text.disabled">없음</Typography>}
                  </Stack>
                </EngineSubBlock>
                <EngineSubBlock tone="secondary" title="E. 숨은 강수 (등장↓·큰매치↑)" sx={{ flex: 1 }}>
                  <Stack direction="row" spacing={0.35} flexWrap="wrap" useFlexGap>
                    {deepAnalysis.hidden.map((h) => (
                      <Box key={`hid-${h.number}`} sx={{ textAlign: 'center', minWidth: 26 }}>
                        <LottoBall number={h.number} size={ENGINE_BALL.list} dimmed={compareWinning && winningSet ? !h.winning : false} />
                        <Typography variant="caption" sx={{ display: 'block', fontSize: 9, color: 'text.disabled', lineHeight: 1.1 }}>최대{h.maxMatch}</Typography>
                      </Box>
                    ))}
                    {deepAnalysis.hidden.length === 0 && <Typography variant="caption" color="text.disabled">없음</Typography>}
                  </Stack>
                </EngineSubBlock>
              </Stack>

              {/* ⑥ 제외 후보 */}
              {deepAnalysis.exclude.length > 0 && (
                <EngineSubBlock
                  tone="warning"
                  title={`F. 제외 후보 (한쪽만 강함 — 양쪽 합의 약함)${compareWinning ? ' · 주황 라벨=실제 당첨(제외 주의)' : ''}`}
                  chips={<EngineStatusChip variant="outlined" label={`${deepAnalysis.exclude.length}개`} />}
                >
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
                    심층역산 합의에서 제외한 번호입니다. 아래 통합 신호의 강한 후보와 겹칠 수 있습니다(축이 다름).
                  </Typography>
                  <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                    {deepAnalysis.exclude.map((e) => (
                      <Box key={`exc-${e.number}`} sx={{ textAlign: 'center', minWidth: 30 }}>
                        <LottoBall number={e.number} size={ENGINE_BALL.list} dimmed />
                        <Typography variant="caption" sx={{ display: 'block', fontSize: 9, lineHeight: 1.1, color: compareWinning && e.winning ? 'warning.light' : 'text.disabled' }}>
                          {e.side}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </EngineSubBlock>
              )}

              {/* ⑦ 빈도·가중치 */}
              <EngineSubBlock tone="neutral" title="G. 빈도·가중치 TOP12" chips={<EngineStatusChip variant="outlined" label="번호·자동·반자동·전체·가중치" />}>
                <Stack direction="row" sx={{ fontSize: 10, fontWeight: 700, color: 'text.secondary', px: 0.5, mb: 0.25 }}>
                  <Box sx={{ width: 42 }}>번호</Box>
                  <Box sx={{ width: 40, textAlign: 'right' }}>자동</Box>
                  <Box sx={{ width: 48, textAlign: 'right' }}>반자동</Box>
                  <Box sx={{ width: 40, textAlign: 'right' }}>전체</Box>
                  <Box sx={{ flex: 1, textAlign: 'right' }}>가중치</Box>
                </Stack>
                {deepAnalysis.freqTable.slice(0, 12).map((f) => {
                  const w = deepAnalysis.weightedRank.find((x) => x.number === f.number);
                  return (
                    <Stack
                      key={`ft-${f.number}`}
                      direction="row"
                      alignItems="center"
                      sx={{ fontSize: 11, px: 0.5, py: 0.15, borderRadius: 0.5, bgcolor: compareWinning && f.winning ? 'rgba(46,125,50,0.28)' : 'transparent' }}
                    >
                      <Box sx={{ width: 42, display: 'flex', alignItems: 'center' }}>
                        <LottoBall number={f.number} size={ENGINE_BALL.table} dimmed={compareWinning && winningSet ? !f.winning : false} />
                      </Box>
                      <Box sx={{ width: 40, textAlign: 'right' }}>{f.auto}</Box>
                      <Box sx={{ width: 48, textAlign: 'right' }}>{f.semi}</Box>
                      <Box sx={{ width: 40, textAlign: 'right', fontWeight: 700 }}>{f.total}</Box>
                      <Box sx={{ flex: 1, textAlign: 'right', color: 'text.secondary' }}>
                        {w ? w.wscore : 0}{w && w.maxMatch >= 3 ? ` (최대${w.maxMatch})` : ''}
                      </Box>
                    </Stack>
                  );
                })}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mt: 0.75 }}>
                  ※ 허브를 축으로 강한 세트가 뭉치고, 숨은 강수가 큰 매치에서만 연결됩니다. 회차마다 흔들리면 우연 — 확률은 불변.
                </Typography>
              </EngineSubBlock>
              </Stack>
            </EngineSection>
          )}

      </Stack>
      </EngineSection>

      {/* ── 엔진② 평행회차 ── */}
      <Box id="engine-parallel">{parallelEngineSlot}</Box>

      {/* ── 엔진③ 검증학습 ── */}
      <EngineSection
        id="engine-validated"
        tone="success"
        collapsible
        defaultOpen
        title={`엔진③ 검증학습 · ${intentSectionLabel} ${effectiveRound ?? '?'}회`}
        chips={
          <>
            <EngineStatusChip
              color={learningBridgeStatus.forwardOnly ? 'secondary' : 'primary'}
              label={learningBridgeStatus.forwardOnly ? 'forward ON' : '복기 표시만'}
            />
            <EngineStatusChip
              color={learningBridgeStatus.validatedCount > 0 ? 'success' : 'default'}
              label={`주입 ${learningBridgeStatus.validatedCount}`}
            />
            <EngineStatusChip
              color={
                learningBridgeStatus.injectRows.find((r) => r.id === 'V4-B')?.status === 'on'
                  ? 'info'
                  : 'default'
              }
              label={
                learningBridgeStatus.injectRows.find((r) => r.id === 'V4-B')?.status === 'on'
                  ? 'V4-B'
                  : learningBridgeStatus.injectRows.find((r) => r.id === 'V4-A')?.status === 'on'
                    ? 'V4-A'
                    : 'V4 —'
              }
            />
          </>
        }
      >
        <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          {(
            [
              ['learn-stats-snapshot', 'Stats'],
              ['learn-v1', 'V1 Feature'],
              ['learn-nested-cv', 'Nested CV'],
              ['learn-shap-drift', 'SHAP/Drift'],
              ['learn-v2', 'V2 Pattern'],
              ['learn-v3', 'V3 다회차'],
              ['learn-v4a', 'V4-A 서버겹침'],
              ['learn-v4b', 'V4-B 복기겹침'],
            ] as const
          ).map(([id, label]) => (
            <EngineStatusChip
              key={id}
              variant="outlined"
              label={label}
              onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              sx={{ cursor: 'pointer' }}
            />
          ))}
        </Stack>
        <Stack spacing={1.5}>
          {validatedLearningSlot}
          {!parallelEngineSlot && !validatedLearningSlot ? engineExtraSlot : null}
        </Stack>
      </EngineSection>

      {/* ── 엔진④ 서버 통합신호 (L9) ── */}
      <EngineSection
        id="engine-signals"
        tone="info"
        collapsible
        defaultOpen={false}
        title={`엔진④ 서버 통합신호 · ${intentSectionLabel} ${predictionSignals?.target_round ?? effectiveRound ?? '?'}회`}
        chips={
          <>
            <EngineStatusChip
              color={predictionSignals ? 'success' : 'default'}
              label={predictionSignals ? `L9 v${predictionSignals.rules_version ?? '…'}` : 'L9 대기'}
            />
            <EngineStatusChip
              variant="outlined"
              label={
                predictionSignals?.machine_id != null
                  ? `${predictionSignals.machine_id}호기${predictionSignals.machine_source === 'confirmed' ? '' : predictionSignals.machine_source === 'estimated' ? '(추정)' : ''}`
                  : '호기 —'
              }
            />
            {compareWinning && (
              <EngineStatusChip color="primary" label="밝은 공=당첨 · 회색=비당첨" />
            )}
            {predictionSignals?.signal_accuracy?.available && (
              <EngineStatusChip color="warning" label="신호원 적중률" />
            )}
          </>
        }
        actions={predictionSignalsQuery.isFetching ? <CircularProgress size={16} /> : undefined}
      >
        <Stack spacing={1.25}>
        {resolvedStrongCandidates.length > 0 && (
          <EngineSubBlock
            tone="primary"
            title={`A. 강한 후보 ${resolvedStrongCandidates.length}개`}
            chips={
              <EngineStatusChip
                variant="outlined"
                label={strongCandidateSource === 'unified-rules' ? '통합 규칙' : '누적/로컬'}
              />
            }
          >
            <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
              {resolvedStrongCandidates.map((n) => (
                <LottoBall
                  key={`strong-${n}`}
                  number={n}
                  size={ENGINE_BALL.list}
                  dimmed={Boolean(compareWinning && winningSet && !winningSet.has(n))}
                />
              ))}
            </Stack>
          </EngineSubBlock>
        )}
        {predictionSignals ? (
          <>
            <EngineSubBlock
              tone="info"
              title="B. 신호원 · 등급 순위"
              chips={
                <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                  <EngineStatusChip variant="outlined" label={predictionSignals.sources.machine.available ? '추첨기✓' : '추첨기—'} />
                  <EngineStatusChip variant="outlined" label={predictionSignals.sources.post_occurrence.available ? '후속✓' : '후속—'} />
                  <EngineStatusChip variant="outlined" label={predictionSignals.sources.classic.available ? '클래식✓' : '클래식—'} />
                  <EngineStatusChip
                    variant="outlined"
                    label={
                      predictionSignals.sources.photo_sheet.available
                        ? `용지✓${predictionSignals.sources.photo_sheet.total_analyses ?? 0}`
                        : '용지—'
                    }
                  />
                  <EngineStatusChip
                    variant="outlined"
                    label={predictionSignals.sources.parallel_round?.available ? '평행✓' : '평행—'}
                  />
                  <EngineStatusChip
                    variant="outlined"
                    label={
                      predictionSignals.sources.decade_gap?.available
                        ? `gap✓${predictionSignals.sources.decade_gap.pool_size ?? 0}`
                        : 'gap—'
                    }
                  />
                </Stack>
              }
            >
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
              {(['S', 'A', 'B'] as const).map((g) => (
                <EngineStatusChip
                  key={g}
                  label={`${GRADE_LABELS[g].split('·')[0].trim()} ${predictionSignals.by_grade[g]?.length ?? 0}개`}
                  sx={{ bgcolor: GRADE_COLORS[g], color: '#fff' }}
                />
              ))}
            </Stack>
            <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
              {predictionSignals.ranked_numbers.slice(0, 12).map((r) => (
                <Box key={`sig-${r.number}`} sx={{ textAlign: 'center' }}>
                  <LottoBall
                    number={r.number}
                    size={ENGINE_BALL.list}
                    dimmed={Boolean(compareWinning && winningSet && !winningSet.has(r.number))}
                  />
                  <Typography variant="caption" sx={{ display: 'block', fontSize: 8, color: 'text.disabled', lineHeight: 1 }}>
                    {r.grade}
                  </Typography>
                </Box>
              ))}
            </Stack>
            <SignalExplanationPanel
              predictionSignals={predictionSignals}
              resolvedStrongCandidates={resolvedStrongCandidates}
              resolvedExcludedCandidates={resolvedExcludedCandidates}
              strongCandidateSource={strongCandidateSource}
            />
            </EngineSubBlock>
            {(() => {
              const acc = predictionSignals.signal_accuracy;
              if (!acc?.available) {
                return compareWinning ? null : (
                  <EngineSubBlock tone="neutral" title="C. 신호원별 적중률">
                    <Typography variant="caption" color="text.secondary">
                      walk-forward 적중률은 <strong>복기 intent</strong> API에서만 동봉됩니다. 복기 탭에서 L9를 여세요.
                    </Typography>
                  </EngineSubBlock>
                );
              }
              const SRC_LABEL: Record<string, string> = {
                machine: '추첨기',
                classic: '클래식',
                parallel: '평행회차',
              };
              return (
                <EngineSubBlock
                  tone="warning"
                  title={`C. 신호원별 적중률 (최근 ${acc.rounds}회차)`}
                  chips={
                    <>
                      <EngineStatusChip variant="outlined" label={`TOP${acc.top_k} · 기대 ${acc.random_baseline}`} />
                      <EngineStatusChip color="warning" label="L9 가중 참고 · 복기 전용" />
                    </>
                  }
                >
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontSize: 10 }}>
                    L9 신호원 캘리브레이션입니다(검증 탭 백테스트와 별개). 무작위 기대보다 낮으면 약한 신호 → 가중 보정 참고.
                  </Typography>
                  <Stack spacing={0.5}>
                    {Object.entries(acc.by_source).map(([src, v]) => {
                      if (!v.available) return null;
                      const weak = src === acc.weakest_source;
                      const strong = src === acc.strongest_source;
                      return (
                        <Stack key={src} direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                          <EngineStatusChip label={SRC_LABEL[src] ?? src} variant="outlined" sx={{ minWidth: 76 }} />
                          <Typography variant="caption">
                            평균 {(v.avg_hits ?? 0).toFixed(2)}개 · 3개+ {v.rounds_3plus}/{v.rounds_tested}회
                          </Typography>
                          <EngineStatusChip
                            color={(v.lift_vs_random ?? 0) > 0 ? 'success' : (v.lift_vs_random ?? 0) < 0 ? 'error' : 'default'}
                            label={`무작위 대비 ${(v.lift_vs_random ?? 0) >= 0 ? '+' : ''}${(v.lift_vs_random ?? 0).toFixed(2)}`}
                          />
                          {weak && <EngineStatusChip color="error" label="약한 신호 ↓보정" />}
                          {strong && <EngineStatusChip color="success" label="강한 신호" />}
                        </Stack>
                      );
                    })}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, fontStyle: 'italic', fontSize: 9 }}>
                    ※ {acc.note}
                  </Typography>
                </EngineSubBlock>
              );
            })()}
          </>
        ) : predictionSignalsQuery.isError ? (
          <Alert severity="warning" sx={{ py: 0.5 }}>
            통합 예측 신호를 불러오지 못했습니다. 재분석으로 다시 시도해 주세요.
          </Alert>
        ) : (
          <Alert severity="info" sx={{ py: 0.5 }}>
            통합 신호 로딩 중… 이번회차는 계산에 시간이 걸릴 수 있습니다.
          </Alert>
        )}
        </Stack>
      </EngineSection>

      </>
      )}

      {engineTab === 'verify' && (
      <>
      <EngineTabBanner
        title="검증·백테스트 — ③ 추천 사후 점검"
        chips={
          <>
            <EngineStatusChip color="info" label="복기 역산 검증" />
            <EngineStatusChip variant="outlined" label="Walk-Forward · 티켓 대조" />
          </>
        }
        intent={
          <>
            신호 성적·다회차 백테스트·Walk-Forward(종합 vs 베이스라인)·놓친 당첨·구간 커버리지로 상단{' '}
            <strong>③ 번호 추천</strong>을 점검합니다. 물리 Venus 추첨기는 ③ 종합 합의에만 1대 둡니다.
          </>
        }
      />
      <Box id="engine-verify-wf" />
      {verificationSlot}

      {/* ── 용지 티켓 당첨 대조 (④ 엔진 · 복기 검증) ── */}
      {activeComparison && (
        <EngineSection
          tone="primary"
          title="용지 티켓 당첨 대조"
          chips={
            <>
              <EngineStatusChip color="info" label="④ 엔진 · 복기검증" />
              <EngineStatusChip variant="outlined" label={`${activeComparison.ticketCount}장`} />
            </>
          }
          collapsible
          open={showTicketCompare}
          onToggle={() => setShowTicketCompare((v) => !v)}
          intent={
            <>
              등록한 자동·반자동 줄이 비교 회차 당첨과 얼마나 맞는지 측정합니다(적중률·분포·티켓 목록).
              상단 <strong>③ 번호 추천</strong>의 사후 점검입니다. 1:1 구조는 <strong>②</strong>에 있습니다.
            </>
          }
        >
          {!compareWinning && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              <strong>이번회차 모드</strong> — 당첨번호·적중률 비교는 표시하지 않습니다.
              당첨 검증은 <strong>복기 탭</strong>을 사용하세요.
              {roundDrawn && (
                <> ({latestRound ?? '?'}회 추첨 완료 — 복기 탭에서 당첨 대조 · 이번회차는 {currentRound ?? '?'}회 미추첨)</>
              )}
            </Alert>
          )}
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
                label={`3개+ 일치(5등↑) ${(activeComparison.hitRates.threePlus * 100).toFixed(2)}%`}
                sx={{ fontWeight: 700 }}
              />
              <Chip
                size="small"
                color="warning"
                label={`4개+ 일치(4등↑) ${(activeComparison.hitRates.fourPlus * 100).toFixed(2)}%`}
              />
              <Chip
                size="small"
                color="error"
                label={`6개 일치(1등) ${(activeComparison.hitRates.six * 100).toFixed(4)}%`}
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
                    <LottoBall key={n} number={n} size={ENGINE_BALL.list} />
                  ))}
                  {comparisonRoundData.bonus != null && (
                    <>
                      <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center', mx: 0.5 }}>
                        + 보너스
                      </Typography>
                      <LottoBall number={comparisonRoundData.bonus} size={ENGINE_BALL.list} />
                    </>
                  )}
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
                        size={ENGINE_BALL.list}
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
                    {/* 자동 영역 — ① 번호 등록(자동)과 동일 데이터 소스 */}
                    <Typography variant="caption" color="success.light" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                      📋 자동 누적: {slipQueue.length}장 · 입력 중 {currentSlipLines.length}/{GAME_LABELS.length}줄 · 대량 {bulkAutoTickets.length}장 · 총 {autoTickets.length}줄
                    </Typography>
                    {autoTickets.length === 0 ? (
                      <Alert severity="info" sx={{ mb: 1.5 }}>
                        자동 데이터가 없습니다. ① 번호 등록의 자동 용지·구입번호 직접입력으로 추가하세요.
                      </Alert>
                    ) : (
                      <Box sx={{ maxHeight: 280, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75, mb: 1.5 }}>
                        <Stack spacing={0.5}>{autoTickets.map(renderRow)}</Stack>
                      </Box>
                    )}

                    {/* 반자동 영역 — ① 번호 등록(반자동)과 동일 데이터 소스 */}
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

          {/* 자동/반자동 한쪽만 있으면 1:1 축이 죽는다 — 조용히 사라지지 않게 사유를 알린다. */}
          {!canRenderLineMatching && hasLineMatchingInputs && (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              현재 <strong>자동 {groupLineMatching.autoLineCount}줄 · 반자동{' '}
              {groupLineMatching.semiLineCount}줄</strong>입니다. ②의 <strong>1:1 전수비교</strong>와
              ④ <strong>학습 엔진</strong> L1~L8 역산은 자동↔반자동 <strong>양쪽</strong>이 있어야 동작합니다.
              비어 있는 쪽을 등록하면 활성화됩니다.
            </Alert>
          )}

        </EngineSection>
      )}
      </>
      )}

        </Stack>
        </Paper>
      )}
      </Box>

      <BulkLineInputDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={handleBulkInsert}
        linesPerSlip={GAME_LABELS.length}
        pickTypeLabel="반자동"
        existingKeys={existingSemiKeys}
      />
      {ConfirmDialog}
    </Stack>
  );
}
