/**
 * 반자동 비교 패널
 *
 * 사용 시나리오: 사용자가 실제 구매한 반자동 용지(일부 사용자 픽 + 일부 자동 배정)를
 * 사진/수동으로 입력한 뒤, 본인이 저장한 데이터 + 누적 분석과 비교.
 *
 * 출력:
 *   - 사용자 픽 vs 자동 배정 4축 비교
 *     1. 최근 당첨 번호 (latest draw) 와의 일치
 *     2. 저장된 매뉴얼 슬립 (slipQueue) 와의 라인별 겹침
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
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import BulkLineInputDialog from './BulkLineInputDialog';
import LottoBall from './LottoBall';
import {
  v1Api,
  type ComboDuplicateItem,
  type ComboDuplicatePatterns,
  type ManualSlipInput,
  type PhotoAnalysisAccumulated,
} from '../api/v1Api';

const NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);

// ── 반자동 비교 영속화 (localStorage) ─────────────────────────────
// 새로고침/페이지 이탈 시에도 사용자 입력 보존. 명시 초기화 시에만 사라짐.
const SEMI_AUTO_STORAGE_KEY = 'lotto:semiAuto:v1';

type PersistedSemiAutoState = {
  picked: number[];
  pickFlags: Record<number, 'user' | 'auto'>;
  bulkTickets: number[][];
};

function defaultPersistedState(): PersistedSemiAutoState {
  return { picked: [], pickFlags: {}, bulkTickets: [] };
}

function loadSemiAutoState(): PersistedSemiAutoState {
  if (typeof window === 'undefined') return defaultPersistedState();
  try {
    const raw = window.localStorage.getItem(SEMI_AUTO_STORAGE_KEY);
    if (!raw) return defaultPersistedState();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return defaultPersistedState();
    const obj = parsed as Partial<PersistedSemiAutoState>;
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
    return { picked, pickFlags, bulkTickets };
  } catch {
    return defaultPersistedState();
  }
}

function saveSemiAutoState(state: PersistedSemiAutoState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEMI_AUTO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
}

/**
 * '이번회차 자동 누적' 데이터 슬라이스 우선순위:
 *   1) accumulated.by_intent.current_round.accumulated_combo_patterns (가장 정확)
 *   2) accumulated.accumulated_combo_patterns (전체 누적 폴백)
 * 둘 다 없으면 null.
 */
function getCurrentRoundComboPatterns(
  accumulated: PhotoAnalysisAccumulated | null
): ComboDuplicatePatterns | null {
  if (!accumulated) return null;
  return (
    accumulated.by_intent?.current_round?.accumulated_combo_patterns ??
    accumulated.accumulated_combo_patterns ??
    null
  );
}

/**
 * 자동 누적의 강한 후보.
 *
 * 주의: PhotoAnalysisIntentSlice 타입 자체에는 final_predictions 가 없으므로
 * 루트 accumulated.final_predictions 만 사용. 이는 전체 누적이지만
 * 현재 백엔드는 current_round 가 절대 다수일 때 root 값이 사실상
 * current_round 누적과 같다.
 */
function getCurrentRoundStrongCandidates(
  accumulated: PhotoAnalysisAccumulated | null
): number[] {
  return accumulated?.final_predictions?.strong_candidates ?? [];
}

function getCurrentRoundExcludedCandidates(
  accumulated: PhotoAnalysisAccumulated | null
): number[] {
  return accumulated?.final_predictions?.excluded_candidates ?? [];
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
}

type PickType = 'user' | 'auto';

interface SlipOverlap {
  slipIdx: number;
  lineLabel: string;
  userOverlap: number[];
  autoOverlap: number[];
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
  comboDataAvailable: boolean;
}

function buildBulkComparison(
  tickets: number[][],
  slipQueue: ManualSlipInput[],
  accumulated: PhotoAnalysisAccumulated | null,
  latestNumbers: number[],
  latestBonus: number | null
): BulkComparisonResult {
  const latestSet = new Set(latestNumbers);

  // 핵심 변경: '이번회차 자동 누적' 슬라이스를 우선 사용
  const strongCandidates = getCurrentRoundStrongCandidates(accumulated);
  const excludedCandidates = getCurrentRoundExcludedCandidates(accumulated);
  const comboPatterns = getCurrentRoundComboPatterns(accumulated);
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
    comboDataAvailable,
  };
}

function buildComparison(
  picked: number[],
  pickFlags: Record<number, PickType>,
  slipQueue: ManualSlipInput[],
  accumulated: PhotoAnalysisAccumulated | null,
  latestNumbers: number[],
  latestBonus: number | null
): ComparisonResult {
  const userPicks = picked.filter((n) => pickFlags[n] === 'user').sort((a, b) => a - b);
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

  const strongCandidates = accumulated?.final_predictions?.strong_candidates ?? [];
  const strongSet = new Set(strongCandidates);
  const vsStrong = {
    available: strongCandidates.length > 0,
    strongCandidates,
    userMatch: userPicks.filter((n) => strongSet.has(n)),
    autoMatch: autoPicks.filter((n) => strongSet.has(n)),
  };

  const excludedCandidates = accumulated?.final_predictions?.excluded_candidates ?? [];
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

function ClassificationChip({
  number,
  type,
  onToggle,
  onDelete,
}: {
  number: number;
  type: PickType;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <Chip
      onClick={onToggle}
      onDelete={onDelete}
      label={`${number} · ${type === 'user' ? '사용자' : '자동'}`}
      color={type === 'user' ? 'primary' : 'default'}
      variant={type === 'user' ? 'filled' : 'outlined'}
      sx={{ fontWeight: 700, cursor: 'pointer' }}
    />
  );
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

export default function SemiAutoComparePanel({
  slipQueue,
  accumulated,
}: SemiAutoComparePanelProps) {
  // localStorage 에서 복원 — 새로고침/이탈 후에도 보존
  const initial = useMemo(() => loadSemiAutoState(), []);
  const [picked, setPicked] = useState<number[]>(initial.picked);
  const [pickFlags, setPickFlags] = useState<Record<number, PickType>>(initial.pickFlags);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTickets, setBulkTickets] = useState<number[][]>(initial.bulkTickets);

  // 영속 — picked/pickFlags/bulkTickets 변경 시 자동 저장
  useEffect(() => {
    saveSemiAutoState({ picked, pickFlags, bulkTickets });
  }, [picked, pickFlags, bulkTickets]);

  const latest = useQuery({
    queryKey: ['v1-latest-for-semi-auto'],
    queryFn: v1Api.getLatestDraw,
    staleTime: 60_000,
  });

  // 메타 — 최신 회차 가져오기 (회차 선택 상한 클램프용)
  const meta = useQuery({
    queryKey: ['v1-meta-for-semi-auto'],
    queryFn: v1Api.getMeta,
    staleTime: 60_000,
  });
  const latestRound = meta.data?.latest_round ?? null;

  // 비교 기준 회차 — 사용자가 수동 선택 가능. 미선택 시 최신 회차.
  const [compareRound, setCompareRound] = useState<number | null>(null);

  // 선택된 회차의 당첨번호 (수동 회차 선택 시)
  const selectedRoundQuery = useQuery({
    queryKey: ['v1-round-for-semi-auto', compareRound],
    queryFn: () => v1Api.getRound(compareRound as number),
    enabled: !!compareRound,
    staleTime: 60_000,
    retry: false,
  });

  // 실제 비교에 사용할 회차 데이터 결정:
  //   수동 선택 시 → selectedRoundQuery.data
  //   미선택 시 → latest.data (최신)
  const comparisonRoundData = compareRound != null ? selectedRoundQuery.data : latest.data;
  const effectiveRound = compareRound ?? latest.data?.round ?? null;

  // 당첨번호 set — 복기 모드에서 ball 색상 강조용
  const winningSet = useMemo<Set<number> | null>(() => {
    if (!comparisonRoundData?.numbers?.length) return null;
    return new Set(comparisonRoundData.numbers);
  }, [comparisonRoundData]);

  const qc = useQueryClient();
  const handleRefreshAll = () => {
    qc.invalidateQueries({ queryKey: ['v1-latest-for-semi-auto'] });
    qc.invalidateQueries({ queryKey: ['v1-meta-for-semi-auto'] });
    qc.invalidateQueries({ queryKey: ['v1-round-for-semi-auto'] });
  };

  // 개별 티켓 삭제 — bulkTickets 누적 중 한 건만 제거
  const deleteOneTicket = (idx: number) => {
    setBulkTickets((prev) => prev.filter((_, i) => i !== idx));
  };

  // UI 토글 상태
  const [showAllTickets, setShowAllTickets] = useState(false);
  const [showFrequency, setShowFrequency] = useState(false);
  const [recommendations, setRecommendations] = useState<number[][]>([]);

  // 전체 번호 빈도 분석 (1~45 모든 번호의 등장 횟수)
  const numberFrequency = useMemo(() => {
    if (bulkTickets.length === 0) return [];
    const counter: Record<number, number> = {};
    for (let n = 1; n <= 45; n += 1) counter[n] = 0;
    for (const ticket of bulkTickets) {
      for (const n of ticket) {
        counter[n] = (counter[n] ?? 0) + 1;
      }
    }
    return Object.entries(counter)
      .map(([n, count]) => ({ number: Number(n), count }))
      .sort((a, b) => b.count - a.count || a.number - b.number);
  }, [bulkTickets]);

  // 추천 조합 생성 — 자동 강한 후보 + 반자동 상위 빈도 결합 → 5세트
  const generateRecommendations = () => {
    const topFreq = numberFrequency.slice(0, 20).map((f) => f.number);
    const strong = getCurrentRoundStrongCandidates(accumulated);
    const excluded = new Set(getCurrentRoundExcludedCandidates(accumulated));
    const pool = Array.from(new Set([...strong, ...topFreq])).filter(
      (n) => !excluded.has(n) && n >= 1 && n <= 45
    );
    // 풀이 부족하면 1~45 무작위로 보충
    if (pool.length < 12) {
      const all = Array.from({ length: 45 }, (_, i) => i + 1).filter(
        (n) => !pool.includes(n) && !excluded.has(n)
      );
      while (pool.length < 12 && all.length > 0) {
        const idx = Math.floor(Math.random() * all.length);
        pool.push(all.splice(idx, 1)[0]);
      }
    }
    const result: number[][] = [];
    const seen = new Set<string>();
    let attempts = 0;
    while (result.length < 5 && attempts < 200) {
      attempts += 1;
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const combo = shuffled.slice(0, 6).sort((a, b) => a - b);
      const key = combo.join('-');
      if (combo.length === 6 && !seen.has(key)) {
        seen.add(key);
        result.push(combo);
      }
    }
    setRecommendations(result);
  };

  const togglePick = (n: number) => {
    if (picked.includes(n)) {
      setPicked(picked.filter((x) => x !== n));
      const next = { ...pickFlags };
      delete next[n];
      setPickFlags(next);
    } else if (picked.length < 6) {
      // 그리드 추가는 6개 cap. 사진 업로드는 별도 경로로 더 추가 가능 (사용자가 삭제로 정리)
      const sorted = [...picked, n].sort((a, b) => a - b);
      setPicked(sorted);
      setPickFlags({ ...pickFlags, [n]: 'user' });
    }
  };

  const toggleType = (n: number) => {
    setPickFlags({
      ...pickFlags,
      [n]: pickFlags[n] === 'user' ? 'auto' : 'user',
    });
  };

  const deletePick = (n: number) => {
    setPicked((prev) => prev.filter((x) => x !== n));
    setPickFlags((prev) => {
      const next = { ...prev };
      delete next[n];
      return next;
    });
  };

  const deleteAllAuto = () => {
    const userOnly = picked.filter((n) => pickFlags[n] !== 'auto');
    setPicked(userOnly);
    setPickFlags((prev) => {
      const next: Record<number, PickType> = {};
      userOnly.forEach((n) => {
        next[n] = prev[n] ?? 'user';
      });
      return next;
    });
  };

  const reset = () => {
    setPicked([]);
    setPickFlags({});
    setPhotoError(null);
    setPhotoNotice(null);
  };

  const handlePhotoUpload = async (file: File) => {
    setPhotoUploading(true);
    setPhotoError(null);
    setPhotoNotice(null);
    try {
      const data = await v1Api.analyzePhotos([file], {
        sheetIntent: 'current_round',
        persist: false,
      });
      // 검출된 번호 후보 — draw_template.marked_numbers 우선, 폴백으로 strong_candidates
      const detected =
        data.result?.extracted_visual_patterns?.draw_template?.marked_numbers ??
        data.result?.final_predictions?.strong_candidates ??
        [];
      // 6개 cap 제거 — OCR이 영수증의 자동 번호까지 잡을 수 있으므로
      // 검출된 모든 유효 번호를 노출하고 사용자가 [×]로 정리하게 함
      const validNums = Array.from(
        new Set(detected.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45))
      );
      if (validNums.length === 0) {
        setPhotoError('사진에서 유효 번호를 검출하지 못했습니다. 아래 그리드에서 직접 선택해 주세요.');
        return;
      }
      const sortedNums = validNums.sort((a, b) => a - b);
      setPicked(sortedNums);
      const flags: Record<number, PickType> = {};
      sortedNums.forEach((n) => {
        flags[n] = 'user'; // 기본 '사용자' — 토글/삭제는 사용자 책임
      });
      setPickFlags(flags);
      setPhotoNotice(
        sortedNums.length === 6
          ? `6개 검출 완료 — 각 번호를 클릭해 [사용자 / 자동] 분류하세요. ` +
              '본 분석은 누적에 저장되지 않습니다.'
          : `${sortedNums.length}개 검출 (목표 6개) — 자동/오인식 번호는 [×]로 삭제 후 분류하세요. ` +
              '본 분석은 누적에 저장되지 않습니다.'
      );
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : '사진 분석 실패');
    } finally {
      setPhotoUploading(false);
    }
  };

  const comparison = useMemo(
    () =>
      buildComparison(
        picked,
        pickFlags,
        slipQueue,
        accumulated,
        latest.data?.numbers ?? [],
        latest.data?.bonus ?? null
      ),
    [picked, pickFlags, slipQueue, accumulated, latest.data]
  );

  // 대량 비교 — comparisonRoundData (수동 선택된 회차 OR 최신) 의 당첨번호 사용
  const bulkComparison = useMemo(
    () =>
      bulkTickets.length > 0
        ? buildBulkComparison(
            bulkTickets,
            slipQueue,
            accumulated,
            comparisonRoundData?.numbers ?? [],
            comparisonRoundData?.bonus ?? null
          )
        : null,
    [bulkTickets, slipQueue, accumulated, comparisonRoundData]
  );

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
    setBulkTickets((prev) => {
      const existingKeys = new Set(
        prev.map((t) => [...t].sort((a, b) => a - b).join('-'))
      );
      let dupCount = 0;
      const merged = [...prev];
      for (const line of lines) {
        const key = [...line].sort((a, b) => a - b).join('-');
        if (existingKeys.has(key)) {
          dupCount += 1;
          continue;
        }
        existingKeys.add(key);
        merged.push([...line].sort((a, b) => a - b));
      }
      // 누적 카운트는 다음 렌더에서 chip 으로 표현되므로 여기서는 console 로 디버그
      if (dupCount > 0) {
        // setNotice 등을 이용해도 좋지만 SemiAutoComparePanel 은 자체 notice state 가 없음 — 향후 추가 가능
      }
      return merged;
    });
  };

  const resetBulk = () => setBulkTickets([]);

  const userCount = comparison.userPicks.length;
  const autoCount = comparison.autoPicks.length;
  const totalPicked = userCount + autoCount;

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            🔄 반자동 비교
          </Typography>
          <Typography variant="caption" color="text.secondary">
            반자동 용지의 6개 번호 입력 → [사용자/자동] 분류 → 기존 데이터와 비교
          </Typography>
        </Box>
        {picked.length > 0 && (
          <Button size="small" onClick={reset}>
            초기화
          </Button>
        )}
      </Stack>

      <Alert severity="warning" icon={false} sx={{ mb: 1.5, fontSize: 12 }}>
        🟡 본 비교는 패턴 관찰 도구입니다. 어떤 일치도 다음 회차의 1/8,145,060 확률을 변경하지 않습니다.
      </Alert>

      {/* 입력 방식: 사진 / 대량 텍스트 / 직접 선택 */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Button
          component="label"
          variant="outlined"
          size="small"
          disabled={photoUploading}
        >
          {photoUploading ? (
            <CircularProgress size={18} sx={{ mr: 1 }} />
          ) : null}
          📷 사진 (단건)
          <input
            hidden
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handlePhotoUpload(file);
              if (e.target) e.target.value = '';
            }}
          />
        </Button>
        <Button
          variant="outlined"
          size="small"
          color="primary"
          onClick={() => setBulkOpen(true)}
        >
          📋 대량 입력 (반자동 500줄+)
        </Button>
        <Typography variant="caption" color="text.secondary">
          OR 아래 그리드에서 직접 선택
        </Typography>
      </Stack>

      {photoError && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {photoError}
        </Alert>
      )}
      {photoNotice && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {photoNotice}
        </Alert>
      )}

      {/* 번호 선택 그리드 */}
      <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
        번호 6개 선택 ({picked.length}/6)
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(15, minmax(0, 1fr))',
          gap: 0.5,
          p: 1,
          borderRadius: 1.5,
          bgcolor: 'action.hover',
          mb: 1.5,
        }}
      >
        {NUMBERS.map((n) => {
          const isPicked = picked.includes(n);
          return (
            <Box
              key={n}
              onClick={() => togglePick(n)}
              sx={{
                display: 'flex',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: isPicked ? 1 : 0.55,
              }}
            >
              <LottoBall number={n} size={24} dimmed={!isPicked} />
            </Box>
          );
        })}
      </Box>

      {/* 분류 칩 */}
      {picked.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 0.5 }}
          >
            <Typography variant="caption">
              각 번호: 클릭=토글, [×]=삭제 · 사용자 {userCount} / 자동 {autoCount} / 총 {picked.length}
            </Typography>
            {autoCount > 0 && (
              <Button size="small" color="error" variant="text" onClick={deleteAllAuto}>
                자동 {autoCount}개 일괄 삭제
              </Button>
            )}
          </Stack>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {picked.map((n) => (
              <ClassificationChip
                key={n}
                number={n}
                type={pickFlags[n] ?? 'user'}
                onToggle={() => toggleType(n)}
                onDelete={() => deletePick(n)}
              />
            ))}
          </Stack>
        </Box>
      )}

      {picked.length > 6 && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          ⚠ {picked.length}개 선택됨 (목표 6개) — 자동/오인식 번호를 [×]로 삭제하거나
          「자동 일괄 삭제」 버튼을 누르세요. 정확히 6개가 되면 비교 결과가 표시됩니다.
        </Alert>
      )}

      {picked.length > 0 && picked.length < 6 && (
        <Typography variant="caption" color="text.secondary">
          {6 - picked.length}개 더 선택하면 비교 결과가 표시됩니다.
        </Typography>
      )}

      {/* 비교 결과 */}
      {totalPicked === 6 && (
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
                    label="사용자"
                    count={comparison.vsLatest.userMatch.length}
                    of={userCount}
                    color="success"
                  />
                  <MatchBadge
                    label="자동"
                    count={comparison.vsLatest.autoMatch.length}
                    of={autoCount}
                    color="success"
                  />
                  {comparison.vsLatest.bonusMatch.user && (
                    <Chip size="small" label="🎁 보너스 (사용자)" color="warning" />
                  )}
                  {comparison.vsLatest.bonusMatch.auto && (
                    <Chip size="small" label="🎁 보너스 (자동)" color="warning" />
                  )}
                </Stack>
              )}
            </Stack>
          </Paper>

          {/* 2. vs 저장된 슬립 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1 }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              💾 vs 저장된 매뉴얼 슬립 ({comparison.vsSavedSlips.slipCount}장)
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
                        label={`사용자 겹침: ${ov.userOverlap.join(', ')}`}
                        sx={{ bgcolor: '#69C8F2', color: '#fff', fontWeight: 700 }}
                      />
                    )}
                    {ov.autoOverlap.length > 0 && (
                      <Chip
                        size="small"
                        label={`자동 겹침: ${ov.autoOverlap.join(', ')}`}
                        variant="outlined"
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
                🏆 vs 누적 강한 후보 (
                {comparison.vsStrong.available
                  ? `${comparison.vsStrong.strongCandidates.length}개`
                  : '데이터 없음'}
                )
              </Typography>
              {comparison.vsStrong.available && (
                <Stack direction="row" spacing={0.5}>
                  <MatchBadge
                    label="사용자"
                    count={comparison.vsStrong.userMatch.length}
                    of={userCount}
                    color="success"
                  />
                  <MatchBadge
                    label="자동"
                    count={comparison.vsStrong.autoMatch.length}
                    of={autoCount}
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
                ⛔ vs 누적 배제 후보 (
                {comparison.vsExcluded.available
                  ? `${comparison.vsExcluded.excludedCandidates.length}개`
                  : '데이터 없음'}
                )
              </Typography>
              {comparison.vsExcluded.available && (
                <Stack direction="row" spacing={0.5}>
                  <MatchBadge
                    label="사용자"
                    count={comparison.vsExcluded.userMatch.length}
                    of={userCount}
                    color="error"
                  />
                  <MatchBadge
                    label="자동"
                    count={comparison.vsExcluded.autoMatch.length}
                    of={autoCount}
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
      {bulkComparison && (
        <>
          <Divider sx={{ my: 2 }} />
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }} flexWrap="wrap" gap={1}>
            <Typography variant="subtitle1" fontWeight={700}>
              📋 대량 비교 결과 ({bulkComparison.ticketCount}장)
            </Typography>
            <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" gap={0.5}>
              <Button size="small" variant="outlined" onClick={handleRefreshAll}>
                ↻ 재분석
              </Button>
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
                helperText={
                  compareRound != null
                    ? '복기 기준'
                    : latest.data
                      ? `최신 ${latest.data.round}회`
                      : ''
                }
              />
              {compareRound != null && (
                <Button size="small" onClick={() => setCompareRound(null)}>
                  ↺ 최신
                </Button>
              )}
              <Button size="small" color="error" variant="outlined" onClick={resetBulk}>
                초기화
              </Button>
            </Stack>
          </Stack>

          {/* 집계 메트릭 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                color="primary"
                label={`평균 적중 ${bulkComparison.avgHits.toFixed(3)} / 6`}
                sx={{ fontWeight: 700 }}
              />
              <Chip size="small" label={`고유 번호 ${bulkComparison.uniqueNumberCount}/45`} variant="outlined" />
              <Chip
                size="small"
                color="success"
                label={`3등이상 ${(bulkComparison.hitRates.threePlus * 100).toFixed(2)}%`}
                sx={{ fontWeight: 700 }}
              />
              <Chip
                size="small"
                color="warning"
                label={`4등이상 ${(bulkComparison.hitRates.fourPlus * 100).toFixed(2)}%`}
              />
              <Chip
                size="small"
                color="error"
                label={`1등 ${(bulkComparison.hitRates.six * 100).toFixed(4)}%`}
              />
              {bulkComparison.excludedWarningCount > 0 && (
                <Chip
                  size="small"
                  color="error"
                  label={`⚠ 배제 매치 2+ 티켓: ${bulkComparison.excludedWarningCount}`}
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              ※ 베이스라인(균등 무작위) 평균 적중 = 0.800 — 본 결과와 비교해 보세요.
            </Typography>
          </Paper>

          {/* 적중 분포 테이블 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              적중 개수 분포
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {[0, 1, 2, 3, 4, 5, 6].map((hits) => {
                const count = bulkComparison.hitDistribution[hits] ?? 0;
                const pct = bulkComparison.ticketCount > 0
                  ? (count / bulkComparison.ticketCount) * 100
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

          {/* 당첨번호 표시 (복기 모드 — 회차 수동 선택 시 강조) */}
          {comparisonRoundData?.numbers && (
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

          {/* 전체 번호 빈도 분석 — 1~45 모든 번호 등장 횟수 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setShowFrequency((v) => !v)}
            >
              <Typography variant="body2" fontWeight={700}>
                📊 전체 번호 빈도 ({bulkComparison.ticketCount}장 기준 · 등장 1+ {numberFrequency.filter(f => f.count > 0).length}개)
                {showFrequency ? ' ▼' : ' ▶'}
              </Typography>
              <Button size="small" variant="text">
                {showFrequency ? '접기' : '펼치기'}
              </Button>
            </Stack>
            {showFrequency && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  빈도순. 평균값 = (티켓수 × 6 / 45). 막대 길이는 최대 빈도 대비 비율.
                </Typography>
                <Box sx={{ maxHeight: 360, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75 }}>
                  <Stack spacing={0.4}>
                    {numberFrequency.map((item, idx) => {
                      const maxCount = numberFrequency[0]?.count ?? 1;
                      const widthPct = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
                      const isWinning = winningSet?.has(item.number);
                      return (
                        <Stack
                          key={item.number}
                          direction="row"
                          alignItems="center"
                          spacing={0.5}
                          flexWrap="wrap"
                          useFlexGap
                        >
                          <Typography variant="caption" sx={{ minWidth: 30, color: 'text.secondary', fontWeight: 600 }}>
                            #{idx + 1}
                          </Typography>
                          <LottoBall number={item.number} size={26} dimmed={winningSet ? !isWinning : false} />
                          <Box sx={{ flex: 1, minWidth: 80, position: 'relative' }}>
                            <LinearProgress
                              variant="determinate"
                              value={widthPct}
                              sx={{
                                height: 18,
                                borderRadius: 1,
                                bgcolor: 'action.selected',
                                '& .MuiLinearProgress-bar': {
                                  bgcolor: isWinning ? 'warning.main' : item.count >= maxCount * 0.7 ? 'success.main' : 'primary.main',
                                },
                              }}
                            />
                            <Typography
                              variant="caption"
                              sx={{
                                position: 'absolute',
                                top: 0,
                                left: 8,
                                lineHeight: '18px',
                                fontWeight: 700,
                                color: '#fff',
                                textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                              }}
                            >
                              {item.count}회 ({((item.count / bulkComparison.ticketCount) * 100).toFixed(1)}%)
                            </Typography>
                          </Box>
                          {isWinning && (
                            <Chip size="small" color="warning" label="🎯 당첨" sx={{ height: 18, fontSize: 10 }} />
                          )}
                        </Stack>
                      );
                    })}
                  </Stack>
                </Box>
              </Box>
            )}
          </Paper>

          {/* 전체 티켓 목록 + 건별 삭제 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setShowAllTickets((v) => !v)}
            >
              <Typography variant="body2" fontWeight={700}>
                🎫 전체 티켓 목록 ({bulkComparison.ticketCount}장) — 건별 삭제 가능
                {showAllTickets ? ' ▼' : ' ▶'}
              </Typography>
              <Button size="small" variant="text">
                {showAllTickets ? '접기' : '펼치기'}
              </Button>
            </Stack>
            {showAllTickets && (
              <Box sx={{ mt: 1, maxHeight: 360, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75 }}>
                <Stack spacing={0.5}>
                  {bulkComparison.perTicket.map((t) => (
                    <Stack
                      key={`all-${t.index}`}
                      direction="row"
                      alignItems="center"
                      spacing={0.5}
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Typography variant="caption" sx={{ minWidth: 36, color: 'text.secondary', fontWeight: 600 }}>
                        #{t.index + 1}
                      </Typography>
                      <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                        {t.ticket.map((n) => {
                          const isWin = winningSet?.has(n);
                          return (
                            <LottoBall
                              key={`${t.index}-${n}`}
                              number={n}
                              size={22}
                              dimmed={winningSet ? !isWin : false}
                            />
                          );
                        })}
                      </Stack>
                      {winningSet && t.vsLatestMatch.length > 0 && (
                        <Chip
                          size="small"
                          color={t.vsLatestMatch.length >= 3 ? 'success' : 'default'}
                          label={`${t.vsLatestMatch.length}/6`}
                          sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                        />
                      )}
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteOneTicket(t.index);
                        }}
                        aria-label={`티켓 ${t.index + 1} 삭제`}
                        sx={{ ml: 'auto' }}
                      >
                        ×
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}
          </Paper>

          {/* 추천 조합 생성 — 자동+반자동 누적 데이터 기반 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="body2" fontWeight={700}>
                🎲 자동+반자동 누적 기반 추천 조합
              </Typography>
              <Button size="small" variant="contained" color="success" onClick={generateRecommendations}>
                추천 5세트 생성
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              누적 자동의 강한 후보 + 반자동의 상위 빈도 번호 결합 → 배제 후보 제외 → 6-튜플 무작위 추출. 정직성:
              어떤 조합도 1/8,145,060 의 동일 확률.
            </Typography>
            {recommendations.length > 0 && (
              <Stack spacing={0.75}>
                {recommendations.map((combo, idx) => (
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
                      {combo.map((n) => (
                        <LottoBall key={n} number={n} size={28} dimmed={winningSet ? !winningSet.has(n) : false} />
                      ))}
                    </Stack>
                    {winningSet && (
                      <Chip
                        size="small"
                        color={combo.filter((n) => winningSet.has(n)).length >= 3 ? 'success' : 'default'}
                        label={`${combo.filter((n) => winningSet.has(n)).length}/6`}
                        sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                      />
                    )}
                  </Stack>
                ))}
              </Stack>
            )}
          </Paper>

          {/* 상위 5개 매칭 티켓 */}
          {bulkComparison.bestTickets.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 1 }}>
                🏆 최근 당첨 대비 매치 상위 5장
              </Typography>
              <Stack spacing={1}>
                {bulkComparison.bestTickets.map((t) => (
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
                        <LottoBall key={n} number={n} size={24} />
                      ))}
                    </Stack>
                    <Chip
                      size="small"
                      color={t.vsLatestMatch.length >= 3 ? 'success' : 'default'}
                      label={`매치 ${t.vsLatestMatch.length}/6${t.bonusMatch ? ' +🎁' : ''}`}
                      sx={{ fontWeight: 700 }}
                    />
                    {t.vsLatestMatch.length > 0 && (
                      <Typography variant="caption" color="text.secondary">
                        ({t.vsLatestMatch.join(', ')})
                      </Typography>
                    )}
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}

          {/* ── 누적 자동 강한 후보 교집합 분포 ────────────────── */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'primary.main' }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              🔗 이번회차 자동 누적 강한 후보 교집합 ({bulkComparison.perTicket[0]?.vsStrongMatch != null && (getCurrentRoundStrongCandidates(accumulated).length)}개 후보)
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              {[0, 1, 2, 3, 4, 5, 6].map((k) => {
                const count = bulkComparison.strongIntersectionDistribution[k] ?? 0;
                const pct = bulkComparison.ticketCount > 0
                  ? (count / bulkComparison.ticketCount) * 100
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
                label={`🟡 2개+ 교집합: ${bulkComparison.twoPlusStrongCount}장 (${bulkComparison.ticketCount > 0 ? (bulkComparison.twoPlusStrongCount / bulkComparison.ticketCount * 100).toFixed(2) : '0.00'}%)`}
                sx={{ fontWeight: 700 }}
              />
              <Chip
                size="small"
                color="success"
                label={`🟢 3개+ 교집합: ${bulkComparison.threePlusStrongCount}장 (${bulkComparison.ticketCount > 0 ? (bulkComparison.threePlusStrongCount / bulkComparison.ticketCount * 100).toFixed(2) : '0.00'}%)`}
                sx={{ fontWeight: 700 }}
              />
            </Stack>
            {getCurrentRoundStrongCandidates(accumulated).length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                ※ 이번회차 자동 누적 데이터가 없습니다. 자동 용지를 분석하여 누적을 만들면 교집합 분석이 활성됩니다.
              </Typography>
            )}

            {/* 교집합 세트별 빈도 — 어느 번호가 정확히 겹친 케이스 (전체 노출) */}
            {(bulkComparison.twoIntersectionGroups.length > 0 ||
              bulkComparison.threeIntersectionGroups.length > 0 ||
              bulkComparison.fourPlusIntersectionGroups.length > 0) && (
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
                    📌 정확한 교집합 세트 — 어떤 번호가 겹쳤는지 (전체)
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    <Chip
                      size="small"
                      label={`총 ${
                        bulkComparison.twoIntersectionGroups.length +
                        bulkComparison.threeIntersectionGroups.length +
                        bulkComparison.fourPlusIntersectionGroups.length
                      }종`}
                      variant="outlined"
                      sx={{ fontWeight: 700 }}
                    />
                    {bulkComparison.twoIntersectionGroups.length > 0 && (
                      <Chip
                        size="small"
                        color="warning"
                        label={`2개: ${bulkComparison.twoIntersectionGroups.length}종`}
                        variant="outlined"
                      />
                    )}
                    {bulkComparison.threeIntersectionGroups.length > 0 && (
                      <Chip
                        size="small"
                        color="success"
                        label={`3개: ${bulkComparison.threeIntersectionGroups.length}종`}
                        variant="outlined"
                      />
                    )}
                    {bulkComparison.fourPlusIntersectionGroups.length > 0 && (
                      <Chip
                        size="small"
                        color="error"
                        label={`4개+: ${bulkComparison.fourPlusIntersectionGroups.length}종`}
                        variant="outlined"
                      />
                    )}
                  </Stack>
                </Stack>

                {/* 2개 교집합 — 전체 노출 (스크롤 컨테이너) */}
                {bulkComparison.twoIntersectionGroups.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography
                      variant="caption"
                      color="warning.light"
                      sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                    >
                      🟡 2개 정확히 겹친 세트 — 전체 {bulkComparison.twoIntersectionGroups.length}종
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
                        {bulkComparison.twoIntersectionGroups.map((g, idx) => {
                          const pct = bulkComparison.ticketCount > 0
                            ? (g.ticketCount / bulkComparison.ticketCount) * 100
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
                                  <LottoBall key={n} number={n} size={26} />
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
                {bulkComparison.threeIntersectionGroups.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography
                      variant="caption"
                      color="success.light"
                      sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                    >
                      🟢 3개 정확히 겹친 세트 — 전체 {bulkComparison.threeIntersectionGroups.length}종
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
                        {bulkComparison.threeIntersectionGroups.map((g, idx) => {
                          const pct = bulkComparison.ticketCount > 0
                            ? (g.ticketCount / bulkComparison.ticketCount) * 100
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
                                  <LottoBall key={n} number={n} size={26} />
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
                {bulkComparison.fourPlusIntersectionGroups.length > 0 && (
                  <Box>
                    <Typography
                      variant="caption"
                      color="error.light"
                      sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}
                    >
                      🔴 4개 이상 겹친 세트 — 전체 {bulkComparison.fourPlusIntersectionGroups.length}종 (희귀)
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
                        {bulkComparison.fourPlusIntersectionGroups.map((g, idx) => {
                          const pct = bulkComparison.ticketCount > 0
                            ? (g.ticketCount / bulkComparison.ticketCount) * 100
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
                                  <LottoBall key={n} number={n} size={26} />
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

          {/* ── 누적 자동 페어/트리플 콤보 교집합 ──────────────── */}
          {bulkComparison.comboDataAvailable && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                🔗 자동 누적 페어/트리플 콤보 교집합
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                <Chip
                  size="small"
                  color="primary"
                  label={`평균 페어 매치 ${bulkComparison.avgPairMatches.toFixed(2)} / 티켓`}
                  sx={{ fontWeight: 700 }}
                />
                <Chip
                  size="small"
                  color="primary"
                  label={`평균 트리플 매치 ${bulkComparison.avgTripleMatches.toFixed(3)} / 티켓`}
                  variant="outlined"
                />
              </Stack>
              <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontWeight: 600 }}>
                페어 매치 분포 (티켓 안에 자동 누적의 자주-페어가 통째로 들어 있는지):
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                {Object.entries(bulkComparison.pairMatchDistribution)
                  .map(([k, v]) => [Number(k), v] as [number, number])
                  .sort((a, b) => a[0] - b[0])
                  .map(([k, v]) => {
                    const pct = bulkComparison.ticketCount > 0
                      ? (v / bulkComparison.ticketCount) * 100
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
                {Object.entries(bulkComparison.tripleMatchDistribution)
                  .map(([k, v]) => [Number(k), v] as [number, number])
                  .sort((a, b) => a[0] - b[0])
                  .map(([k, v]) => {
                    const pct = bulkComparison.ticketCount > 0
                      ? (v / bulkComparison.ticketCount) * 100
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
          {bulkComparison.bestComboTickets.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 1 }}>
                🥇 누적 자동과 가장 잘 맞은 티켓 5장 (페어 1점 · 트리플 3점 · 쿼드 6점)
              </Typography>
              <Stack spacing={0.75}>
                {bulkComparison.bestComboTickets.map((t) => (
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
                        <LottoBall key={n} number={n} size={22} />
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

      <BulkLineInputDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={handleBulkInsert}
        linesPerSlip={6}
      />
    </Paper>
  );
}
