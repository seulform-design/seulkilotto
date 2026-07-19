/**
 * 이전 이번회차 백테스트 패널.
 *
 * 사용 시나리오: 사용자가 1227회용 자동 용지를 누적 분석해 strong/excluded
 * 예측을 만들었고, 그 후 1227회가 추첨되어 실제 당첨번호가 공개됨.
 * 이 패널은 자동 누적의 예측이 실제 결과에 얼마나 부합했는지 검증한다.
 *
 * 6가지 지표:
 *   1. 강한 후보 vs 당첨 — true positive 매치 카운트
 *   2. 강한 후보 vs 보너스 — 보너스 매치 여부
 *   3. 배제 후보 vs 당첨 — false positive (배제했는데 나옴, 0이 이상적)
 *   4. 누적 자주-페어가 당첨 조합 안에 통째로 들어 있는지
 *   5. 누적 자주-트리플이 당첨 조합 안에
 *   6. 누적 자주-쿼드가 당첨 조합 안에
 *
 * 회차 업그레이드 펜딩 상태도 함께 노출 (있을 시 클릭으로 업그레이드 실행).
 *
 * 정직성: 본 패널은 backward-looking 자기 검증 도구. 다음 회차의
 * 1/8,145,060 확률은 변경 불가.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import LottoBall from './LottoBall';
import {
  v1Api,
  type ArchivedCurrentRoundSnapshot,
  type ComboDuplicateItem,
  type ComboDuplicatePatterns,
  type PhotoAnalysisAccumulated,
} from '../api/v1Api';

interface PhotoBacktestPanelProps {
  accumulated: PhotoAnalysisAccumulated | null;
}

// ── 백테스트 이력 영속화 ─────────────────────────────────────────
// 백테스트 결과를 localStorage 에 저장하여 회차 전환·새로고침 후에도
// 과거 회차들의 백테스트 요약을 다시 볼 수 있게 한다.
const BACKTEST_HISTORY_KEY = 'lotto:photoBacktest:history:v1';
const BACKTEST_HISTORY_LIMIT = 20;

interface BacktestSnapshot {
  round: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  strongHits: number;
  totalStrong: number;
  excludedHits: number;
  totalExcluded: number;
  bonusInStrong: boolean;
  matchedPairs: number;
  matchedTriples: number;
  matchedQuads: number;
  winningNumbers: number[];
  bonus: number;
  recordedAt: number;
}

function loadBacktestHistory(): BacktestSnapshot[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BACKTEST_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is BacktestSnapshot =>
        !!s && typeof s === 'object' && Number.isInteger(s.round) && typeof s.grade === 'string'
    );
  } catch {
    return [];
  }
}

function saveBacktestHistory(history: BacktestSnapshot[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BACKTEST_HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* quota — silent */
  }
}

function upsertBacktestSnapshot(
  existing: BacktestSnapshot[],
  snapshot: BacktestSnapshot
): BacktestSnapshot[] {
  // 같은 회차는 최신값으로 덮어쓰고 최신순 정렬, 상한 cap
  const filtered = existing.filter((s) => s.round !== snapshot.round);
  return [snapshot, ...filtered].slice(0, BACKTEST_HISTORY_LIMIT);
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return `방금 전`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  return `${Math.floor(diffSec / 86400)}일 전`;
}

// ── 게임 줄별 적중 분석 (반자동 bulkTickets 기반) ───────────────
// SemiAutoComparePanel 에서 저장한 bulkTickets 를 동일 localStorage 키
// 로 로드하여, 선택된 백테스트 회차의 당첨번호와 비교한다.
const SEMI_AUTO_STORAGE_KEYS = [
  'lotto:semiAuto:v1:current_round',
  'lotto:semiAuto:v1',
] as const;

function loadBulkTickets(): number[][] {
  if (typeof window === 'undefined') return [];
  try {
    for (const key of SEMI_AUTO_STORAGE_KEYS) {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { bulkTickets?: unknown };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.bulkTickets)) {
        continue;
      }
      const result: number[][] = [];
      for (const t of parsed.bulkTickets) {
        if (!Array.isArray(t)) continue;
        const nums: number[] = [];
        for (const n of t) {
          if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 45) {
            nums.push(n as number);
          }
        }
        if (nums.length === 6) result.push(nums);
      }
      if (result.length > 0) return result;
    }
    return [];
  } catch {
    return [];
  }
}

type PrizeTier = '1등' | '2등' | '3등' | '4등' | '5등' | '미당첨';

const TIER_ORDER: PrizeTier[] = ['1등', '2등', '3등', '4등', '5등', '미당첨'];
const TIER_COLORS: Record<PrizeTier, string> = {
  '1등': '#FF4D4D',
  '2등': '#FFA94D',
  '3등': '#FBC400',
  '4등': '#69C8F2',
  '5등': '#B0D840',
  '미당첨': '#9CA3AF',
};

function classifyPrize(hitCount: number, bonusMatch: boolean): PrizeTier {
  if (hitCount === 6) return '1등';
  if (hitCount === 5 && bonusMatch) return '2등';
  if (hitCount === 5) return '3등';
  if (hitCount === 4) return '4등';
  if (hitCount === 3) return '5등';
  return '미당첨';
}

interface TicketLineAnalysis {
  idx: number;
  ticket: number[];
  matchedNumbers: number[];
  hitCount: number;
  bonusMatch: boolean;
  tier: PrizeTier;
}

function analyzeTicketLines(
  tickets: number[][],
  winning: number[],
  bonus: number
): TicketLineAnalysis[] {
  const winningSet = new Set(winning);
  return tickets.map((ticket, idx) => {
    const matchedNumbers = ticket.filter((n) => winningSet.has(n));
    const bonusMatch = ticket.includes(bonus);
    return {
      idx,
      ticket,
      matchedNumbers,
      hitCount: matchedNumbers.length,
      bonusMatch,
      tier: classifyPrize(matchedNumbers.length, bonusMatch),
    };
  });
}

function findComboMatches(
  ticket: number[],
  combos: ComboDuplicatePatterns | null | undefined
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

export default function PhotoBacktestPanel({ accumulated }: PhotoBacktestPanelProps) {
  const qc = useQueryClient();

  const meta = useQuery({ queryKey: ['v1-meta-for-backtest'], queryFn: v1Api.getMeta });
  const upgradeStatus = useQuery({
    queryKey: ['v1-upgrade-status-for-backtest'],
    queryFn: v1Api.getUpgradeStatus,
    staleTime: 60_000,
  });

  // 이번회차(미추첨) 통합 예측 후보 미리보기 — 추첨 후 백테스트될 '바로 그 18개'.
  // 라이브 통합 예측 신호와 동일 소스라 백테스트와 일원화된다.
  const currentSignals = useQuery({
    queryKey: ['v1-prediction-signals-backtest', 'current_round'],
    queryFn: () => v1Api.getPredictionSignals('current_round'),
    staleTime: 120_000,
    retry: 1,
  });

  const upgrade = useMutation({
    mutationFn: () => v1Api.runUpgrade(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v1-meta-for-backtest'] });
      qc.invalidateQueries({ queryKey: ['v1-upgrade-status-for-backtest'] });
      qc.invalidateQueries({ queryKey: ['v1-meta'] });
      qc.invalidateQueries({ queryKey: ['v1-latest'] });
    },
  });

  // 누적 current_round 슬라이스 — 이전 회차에 대한 예측
  const liveSlice = accumulated?.by_intent?.current_round ?? null;
  const archivedSlice: ArchivedCurrentRoundSnapshot | null =
    accumulated?.historical_dataset?.latest_archived_current_snapshot ?? null;
  const slice = ((liveSlice?.total_analyses ?? 0) > 0 ? liveSlice : archivedSlice) ?? null;
  const sliceTicketRoundStr = slice?.ticket_round?.trim();

  // 백테스트 대상 회차 결정 (3단계 fallback):
  //   1) 사용자 수동 선택 (manualRound) 우선
  //   2) 슬라이스 ticket_round 가 latest_round 이하 → 그것
  //   3) ticket_round 가 미래/없음 → latest_round
  const latestRound = meta.data?.latest_round ?? null;
  const [manualRound, setManualRound] = useState<number | null>(null);
  const [history, setHistory] = useState<BacktestSnapshot[]>(() => loadBacktestHistory());

  const autoSelectedRound = useMemo(() => {
    if (!latestRound) return null;
    if (sliceTicketRoundStr) {
      const parsed = Number(sliceTicketRoundStr);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= latestRound) {
        return parsed;
      }
    }
    return latestRound;
  }, [sliceTicketRoundStr, latestRound]);

  const targetRound = manualRound ?? autoSelectedRound;

  // ⚠️ 백테스트는 '그 회차의 예측' 과 '그 회차의 당첨' 을 짝지어야 한다.
  // archivedSlice 는 **가장 최근 보관 배치 하나**로 고정인데 targetRound 는 사용자가
  // 임의 선택할 수 있어, 그대로 두면 1233 예측을 1230 당첨과 채점하고 그 결과를
  // 이력에 영구 저장하는 오염이 생긴다. 회차가 일치할 때만 채점한다.
  const sliceRoundNo =
    (slice as ArchivedCurrentRoundSnapshot | null)?.round_no ??
    (sliceTicketRoundStr && /^\d+$/.test(sliceTicketRoundStr) ? Number(sliceTicketRoundStr) : null);
  const sliceMatchesTarget =
    sliceRoundNo != null && targetRound != null && sliceRoundNo === targetRound;

  // 미래 회차 예측인지 표시 — UI에 명시
  const isPredictingFutureRound = useMemo(() => {
    if (!sliceTicketRoundStr || !latestRound) return false;
    const parsed = Number(sliceTicketRoundStr);
    return Number.isInteger(parsed) && parsed > latestRound;
  }, [sliceTicketRoundStr, latestRound]);

  const round = useQuery({
    queryKey: ['round-for-backtest', targetRound],
    queryFn: () => v1Api.getRound(targetRound as number),
    enabled: !!targetRound,
    staleTime: 60_000,
    retry: false, // 404 는 재시도해도 같은 결과 — 콘솔 노이즈 방지
  });

  // 반자동 bulkTickets 로드 (localStorage 직접 — SemiAutoComparePanel 과 키 공유)
  // round.data 변화 시 재로드 (사용자가 회차 전환 등으로 화면 다시 그릴 때)
  const bulkTickets = useMemo(() => loadBulkTickets(), [round.data]);

  // 백테스트 가능성 판정:
  //   - 슬라이스가 존재해야 함
  //   - 대상 회차가 결정되어야 함
  //   - 대상 회차가 실제 추첨됐어야 함 (round.data 가 winning numbers 보유)
  const hasSlice = !!slice && (slice.total_analyses ?? 0) > 0;
  const usingArchivedSlice = Boolean(
    archivedSlice &&
    ((liveSlice?.total_analyses ?? 0) === 0) &&
    ((archivedSlice.total_analyses ?? 0) > 0)
  );
  const roundDrawn = !!round.data && round.data.numbers?.length === 6;

  // 분석 계산
  const analysis = useMemo(() => {
    // 회차 불일치 시 채점 금지 — 다른 회차 예측을 이 회차 당첨과 비교하면 안 된다.
    if (!hasSlice || !roundDrawn || !sliceMatchesTarget || !round.data || !accumulated) return null;

    const winning: number[] = round.data.numbers;
    const bonus: number = round.data.bonus;
    const winningSet = new Set<number>(winning);
    // 통합 신호(6소스) 강한후보를 우선 — 라이브 '통합 예측 신호' 와 동일 소스로 평가해
    // 불일치를 없앤다. 구버전 보관본(통합 미아카이브)만 용지 전용으로 폴백.
    const archivedUnified = (slice as ArchivedCurrentRoundSnapshot)?.unified_strong_candidates;
    const usedUnified = Array.isArray(archivedUnified) && archivedUnified.length > 0;
    const strongCandidates: number[] = usedUnified
      ? (archivedUnified as number[])
      : (slice?.final_predictions?.strong_candidates ?? []);
    const excludedCandidates: number[] =
      (slice as ArchivedCurrentRoundSnapshot)?.unified_excluded_candidates?.length
        ? ((slice as ArchivedCurrentRoundSnapshot).unified_excluded_candidates as number[])
        : (slice?.final_predictions?.excluded_candidates ?? []);

    const strongHits = strongCandidates.filter((n: number) => winningSet.has(n));
    const strongMisses = strongCandidates.filter((n: number) => !winningSet.has(n));
    const excludedHits = excludedCandidates.filter((n: number) => winningSet.has(n));
    const bonusInStrong = strongCandidates.includes(bonus);
    const bonusInExcluded = excludedCandidates.includes(bonus);

    // 콤보 매치: 당첨 조합 안에 누적 자주-페어/트리플/쿼드가 통째로 들어 있는지
    const comboPatterns = slice?.accumulated_combo_patterns ?? null;
    const { matchedPairs, matchedTriples, matchedQuads } = findComboMatches(winning, comboPatterns);

    // 누적 자주-페어/트리플 총 개수 (모집단)
    const pairTotal = comboPatterns?.pair_duplicates?.length ?? 0;
    const tripleTotal = comboPatterns?.triple_duplicates?.length ?? 0;
    const quadTotal = comboPatterns?.quad_duplicates?.length ?? 0;

    // 평가 점수 산정: hit/miss/false-positive 기반 정성 등급
    const strongHitRate = strongCandidates.length > 0 ? strongHits.length / strongCandidates.length : 0;
    const winningCoverage = winning.length > 0 ? strongHits.length / winning.length : 0;
    const excludedFalsePositiveRate =
      excludedCandidates.length > 0 ? excludedHits.length / excludedCandidates.length : 0;

    // 종합 등급
    let grade: 'S' | 'A' | 'B' | 'C' | 'D' = 'C';
    if (strongHits.length >= 5 && excludedHits.length === 0) grade = 'S';
    else if (strongHits.length >= 4 && excludedHits.length <= 1) grade = 'A';
    else if (strongHits.length >= 3) grade = 'B';
    else if (strongHits.length >= 2) grade = 'C';
    else grade = 'D';

    return {
      winning,
      bonus,
      strongCandidates,
      excludedCandidates,
      strongHits,
      strongMisses,
      excludedHits,
      bonusInStrong,
      bonusInExcluded,
      matchedPairs,
      matchedTriples,
      matchedQuads,
      pairTotal,
      tripleTotal,
      quadTotal,
      strongHitRate,
      winningCoverage,
      excludedFalsePositiveRate,
      grade,
      usedUnified,
    };
  }, [hasSlice, roundDrawn, sliceMatchesTarget, round.data, slice, accumulated]);

  // 반자동 게임 줄별 적중 분석 — 선택된 회차 vs 모든 bulkTickets
  const lineAnalysis = useMemo(() => {
    if (!analysis || bulkTickets.length === 0) return null;
    return analyzeTicketLines(bulkTickets, analysis.winning, analysis.bonus);
  }, [analysis, bulkTickets]);

  const lineGroupsByTier = useMemo(() => {
    if (!lineAnalysis) return null;
    const groups: Record<PrizeTier, TicketLineAnalysis[]> = {
      '1등': [],
      '2등': [],
      '3등': [],
      '4등': [],
      '5등': [],
      '미당첨': [],
    };
    for (const a of lineAnalysis) {
      groups[a.tier].push(a);
    }
    return groups;
  }, [lineAnalysis]);

  const [expandedTiers, setExpandedTiers] = useState<Record<PrizeTier, boolean>>({
    '1등': true,
    '2등': true,
    '3등': true,
    '4등': true,
    '5등': true,
    '미당첨': false,
  });

  const toggleTier = (tier: PrizeTier) => {
    setExpandedTiers((prev) => ({ ...prev, [tier]: !prev[tier] }));
  };

  // 분석 성공 시 이력에 자동 저장 (snapshot)
  useEffect(() => {
    if (!analysis || !targetRound) return;
    const snapshot: BacktestSnapshot = {
      round: targetRound,
      grade: analysis.grade,
      strongHits: analysis.strongHits.length,
      totalStrong: analysis.strongCandidates.length,
      excludedHits: analysis.excludedHits.length,
      totalExcluded: analysis.excludedCandidates.length,
      bonusInStrong: analysis.bonusInStrong,
      matchedPairs: analysis.matchedPairs.length,
      matchedTriples: analysis.matchedTriples.length,
      matchedQuads: analysis.matchedQuads.length,
      winningNumbers: analysis.winning,
      bonus: analysis.bonus,
      recordedAt: Date.now(),
    };
    setHistory((prev) => {
      const next = upsertBacktestSnapshot(prev, snapshot);
      saveBacktestHistory(next);
      return next;
    });
  }, [analysis, targetRound]);

  const clearHistory = () => {
    if (!window.confirm(`백테스트 이력 ${history.length}건을 모두 삭제할까요?`)) return;
    setHistory([]);
    saveBacktestHistory([]);
  };

  // 데이터 부재 — 패널 렌더 안 함
  if (!accumulated || !hasSlice) {
    return null;
  }

  const gradeColors: Record<string, string> = {
    S: '#FF4D4D',
    A: '#FFA94D',
    B: '#69C8F2',
    C: '#9CA3AF',
    D: '#7B61FF',
  };

  return (
    <Paper sx={{ p: 2, mb: 2, borderLeft: '4px solid', borderLeftColor: 'warning.main' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            🧪 이전 이번회차 백테스트
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {targetRound
              ? `${targetRound}회 자동 누적 ${slice?.total_analyses ?? 0}건 → 실제 결과 비교${usingArchivedSlice ? ' (보관본)' : ''}`
              : '회차 정보 없음'}
          </Typography>
        </Box>
        {upgradeStatus.data?.can_upgrade && (
          <Button
            size="small"
            color="warning"
            variant="contained"
            onClick={() => upgrade.mutate()}
            disabled={upgrade.isPending}
          >
            {upgrade.isPending ? (
              <CircularProgress size={18} color="inherit" />
            ) : (
              `↻ ${upgradeStatus.data.pending_count}개 회차 업데이트`
            )}
          </Button>
        )}
      </Stack>

      {/* 펜딩 회차 알림 */}
      {upgradeStatus.data?.pending_count != null && upgradeStatus.data.pending_count > 0 && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          신규 회차 {upgradeStatus.data.pending_count}개 ({upgradeStatus.data.pending_rounds?.join(', ')})
          업데이트 가능. 업데이트 후 백테스트가 갱신됩니다.
        </Alert>
      )}

      {usingArchivedSlice && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          이번회차 실시간 누적이 비어 있어, 마지막 롤오버 때 보관된 {slice?.ticket_round}회 스냅숏으로 백테스트를 표시합니다.
        </Alert>
      )}

      {/* 회차 선택 — 수동 오버라이드 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 1.5 }}
      >
        <TextField
          size="small"
          label="백테스트 회차"
          type="number"
          value={targetRound ?? ''}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v > 0 && (!latestRound || v <= latestRound)) {
              setManualRound(v);
            } else if (e.target.value === '') {
              setManualRound(null);
            }
          }}
          inputProps={{ min: 1, max: latestRound ?? undefined, step: 1 }}
          sx={{ width: 140 }}
          helperText={
            manualRound != null
              ? '수동 선택'
              : autoSelectedRound != null
                ? '자동 선택'
                : '회차 없음'
          }
        />
        {manualRound != null && (
          <Button size="small" onClick={() => setManualRound(null)}>
            ↺ 자동
          </Button>
        )}
        {latestRound && targetRound && targetRound < latestRound && (
          <Button
            size="small"
            onClick={() => setManualRound((targetRound ?? 1) + 1)}
            disabled={!targetRound || targetRound >= latestRound}
          >
            다음 회차 →
          </Button>
        )}
        {targetRound && targetRound > 1 && (
          <Button
            size="small"
            onClick={() => setManualRound((targetRound ?? 2) - 1)}
            disabled={!targetRound || targetRound <= 1}
          >
            ← 이전 회차
          </Button>
        )}
        {latestRound && (
          <Typography variant="caption" color="text.secondary">
            최신 추첨 회차: {latestRound}
          </Typography>
        )}
      </Stack>

      {/* 데이터 로딩 */}
      {round.isLoading && (
        <Stack direction="row" alignItems="center" spacing={1}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            {targetRound}회 당첨 데이터 로딩...
          </Typography>
        </Stack>
      )}

      {/* 미래 회차 예측 안내 */}
      {isPredictingFutureRound && (
        <Alert severity="info" sx={{ mb: 1 }}>
          누적 데이터의 예측 대상은 {sliceTicketRoundStr}회 (미추첨)입니다.
          {targetRound}회 (이미 추첨됨) 기준으로 백테스트 결과를 보여드립니다.
        </Alert>
      )}

      {/* 추첨 전 / 데이터 없음 */}
      {!round.isLoading && !roundDrawn && (
        <Alert severity="warning">
          {targetRound}회 데이터를 찾지 못했습니다. 회차 업데이트를 실행하거나, 추첨 후 다시 확인해 주세요.
        </Alert>
      )}

      {/* 회차 불일치 — 보관된 예측 회차와 채점 대상 회차가 다르면 채점하지 않는다. */}
      {hasSlice && roundDrawn && !sliceMatchesTarget && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          보관된 예측은 <strong>{sliceRoundNo ?? '?'}회</strong> 것인데 채점 대상은{' '}
          <strong>{targetRound}회</strong>입니다. 다른 회차의 예측을 이 회차 당첨번호로 채점하면
          결과가 무의미해지므로 <strong>채점을 생략</strong>했습니다.
          {sliceRoundNo != null && (
            <>
              {' '}
              <Button size="small" variant="outlined" color="inherit" sx={{ ml: 1 }} onClick={() => setManualRound(sliceRoundNo)}>
                {sliceRoundNo}회로 맞추기
              </Button>
            </>
          )}
        </Alert>
      )}

      {/* 이번회차(미추첨) 통합 예측 후보 미리보기 — 추첨 후 백테스트될 '바로 그 후보' */}
      {!roundDrawn && (currentSignals.data?.strong_candidates?.length ?? 0) > 0 && (
        <Paper variant="outlined" sx={{ p: 1.5, mt: 1.5, borderColor: 'info.main' }}>
          <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
            🔮 이번회차({currentSignals.data?.target_round}회) 예측 후보{' '}
            {currentSignals.data?.strong_candidates.length}개 — 추첨 후 백테스트 예정
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            라이브 &lt;통합 예측 신호(6소스)&gt; 와 동일한 후보입니다. 추첨이 완료되면 이 후보들이
            그대로 채점됩니다 — 라이브와 백테스트가 일원화되어 강한후보가 어긋나지 않습니다.
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {currentSignals.data?.strong_candidates.map((n) => (
              <LottoBall key={`pv-${n}`} number={n} size={28} />
            ))}
          </Stack>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.75, fontStyle: 'italic' }}>
            ※ 1등 확률(1/8,145,060)은 불변 — 후보 표시는 분석 일관성일 뿐입니다.
          </Typography>
        </Paper>
      )}

      {/* 백테스트 결과 */}
      {analysis && (
        <>
          {/* 당첨 번호 */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
              {targetRound}회 실제 당첨번호
            </Typography>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              {analysis.winning.map((n) => (
                <LottoBall key={n} number={n} size={36} />
              ))}
              <Typography variant="caption" color="text.secondary" sx={{ mx: 0.5 }}>
                + 보너스
              </Typography>
              <LottoBall number={analysis.bonus} size={32} />
              <Chip
                size="small"
                label={`종합 등급: ${analysis.grade}`}
                sx={{
                  bgcolor: gradeColors[analysis.grade],
                  color: '#fff',
                  fontWeight: 700,
                  ml: 1,
                }}
              />
            </Stack>
          </Box>

          {/* 강한 후보 vs 당첨 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 0.5 }}
            >
              <Typography variant="body2" fontWeight={700}>
                🏆 강한 후보 적중 ({analysis.strongHits.length}/{analysis.strongCandidates.length})
              </Typography>
              <Stack direction="row" spacing={0.5}>
                <Chip
                  size="small"
                  color="success"
                  label={`당첨 6개 중 ${analysis.strongHits.length} 매치 (${(analysis.winningCoverage * 100).toFixed(1)}%)`}
                  sx={{ fontWeight: 700 }}
                />
                {analysis.bonusInStrong && (
                  <Chip size="small" color="warning" label="🎁 보너스 매치" />
                )}
              </Stack>
            </Stack>
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.5 }}>
              {analysis.usedUnified
                ? '기준: 통합 예측 신호(6소스) — 라이브 강한후보와 동일'
                : '기준: 용지 전용(구버전 보관본) — 이후 회차부터 통합 신호로 일원화 채점'}
            </Typography>
            {analysis.strongHits.length > 0 && (
              <Box sx={{ mb: 0.5 }}>
                <Typography variant="caption" color="success.light" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                  ✅ 적중한 강한 후보
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {analysis.strongHits.map((n) => (
                    <LottoBall key={n} number={n} size={28} />
                  ))}
                </Stack>
              </Box>
            )}
            {analysis.strongMisses.length > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                  ⚪ 빗나간 강한 후보 ({analysis.strongMisses.length})
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {analysis.strongMisses.map((n) => (
                    <LottoBall key={n} number={n} size={24} dimmed />
                  ))}
                </Stack>
              </Box>
            )}
          </Paper>

          {/* 배제 후보 검증 */}
          <Paper
            variant="outlined"
            sx={{
              p: 1.5,
              mb: 1.5,
              borderColor: analysis.excludedHits.length > 0 ? 'error.main' : undefined,
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 0.5 }}
            >
              <Typography variant="body2" fontWeight={700} color={analysis.excludedHits.length > 0 ? 'error.main' : undefined}>
                ⛔ 배제 후보 검증 (false positive)
              </Typography>
              <Chip
                size="small"
                color={analysis.excludedHits.length === 0 ? 'success' : 'error'}
                label={
                  analysis.excludedHits.length === 0
                    ? `완벽: 배제 ${analysis.excludedCandidates.length}개 중 0 false positive`
                    : `오류: 배제했는데 ${analysis.excludedHits.length}개 등장`
                }
                sx={{ fontWeight: 700 }}
              />
            </Stack>
            {analysis.excludedHits.length > 0 && (
              <>
                <Typography variant="caption" color="error.light" sx={{ display: 'block', mb: 0.5 }}>
                  ❌ 배제했는데 당첨된 번호 (가설 약함)
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {analysis.excludedHits.map((n) => (
                    <LottoBall key={n} number={n} size={28} />
                  ))}
                </Stack>
              </>
            )}
            {analysis.bonusInExcluded && (
              <Typography variant="caption" color="warning.light" sx={{ mt: 0.5, display: 'block' }}>
                ⚠ 보너스 번호 {analysis.bonus} 도 배제 후보였음
              </Typography>
            )}
          </Paper>

          {/* 콤보 매치 — 당첨 조합 안의 누적 자주-페어/트리플 */}
          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
            <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
              🔗 당첨 조합 안의 누적 자주-콤보 매치
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              <Chip
                size="small"
                color={analysis.matchedPairs.length > 0 ? 'success' : 'default'}
                variant={analysis.matchedPairs.length > 0 ? 'filled' : 'outlined'}
                label={`페어 ${analysis.matchedPairs.length}/${analysis.pairTotal}`}
              />
              <Chip
                size="small"
                color={analysis.matchedTriples.length > 0 ? 'success' : 'default'}
                variant={analysis.matchedTriples.length > 0 ? 'filled' : 'outlined'}
                label={`트리플 ${analysis.matchedTriples.length}/${analysis.tripleTotal}`}
              />
              {analysis.quadTotal > 0 && (
                <Chip
                  size="small"
                  color={analysis.matchedQuads.length > 0 ? 'success' : 'default'}
                  variant={analysis.matchedQuads.length > 0 ? 'filled' : 'outlined'}
                  label={`쿼드 ${analysis.matchedQuads.length}/${analysis.quadTotal}`}
                />
              )}
            </Stack>
            {analysis.matchedTriples.length > 0 && (
              <Box>
                <Typography variant="caption" color="success.light" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                  🟢 적중한 자주-트리플
                </Typography>
                <Stack spacing={0.5}>
                  {analysis.matchedTriples.map((t, i) => (
                    <Stack
                      key={`tri-${i}`}
                      direction="row"
                      spacing={0.5}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {t.numbers.map((n) => (
                          <LottoBall key={n} number={n} size={24} />
                        ))}
                      </Stack>
                      <Chip size="small" variant="outlined" label={`${t.repeat_count ?? 0}장에서 등장`} />
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}
            {analysis.matchedPairs.length > 0 && analysis.matchedTriples.length === 0 && (
              <Box>
                <Typography variant="caption" color="success.light" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                  적중한 자주-페어 ({Math.min(analysis.matchedPairs.length, 5)} 노출)
                </Typography>
                <Stack spacing={0.5}>
                  {analysis.matchedPairs.slice(0, 5).map((p, i) => (
                    <Stack
                      key={`pair-${i}`}
                      direction="row"
                      spacing={0.5}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {p.numbers.map((n) => (
                          <LottoBall key={n} number={n} size={22} />
                        ))}
                      </Stack>
                      <Chip size="small" variant="outlined" label={`${p.repeat_count ?? 0}장에서 등장`} />
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}
            {analysis.matchedPairs.length + analysis.matchedTriples.length + analysis.matchedQuads.length === 0 && (
              <Typography variant="caption" color="text.secondary">
                당첨 조합 안에 누적 자주-콤보가 들어있지 않음 — 군중 패턴과 결과가 무관
              </Typography>
            )}
          </Paper>

          {/* ── 🎯 게임 줄별 적중 분석 (반자동 bulkTickets vs 선택 회차) ── */}
          {lineAnalysis && lineGroupsByTier && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'success.main' }}>
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                🎯 반자동 게임 줄별 적중 ({bulkTickets.length}줄 vs {targetRound}회 당첨)
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                반자동 비교 패널에 입력된 {bulkTickets.length}장 전체를 {targetRound}회 당첨번호로 재검증합니다.
              </Typography>

              {/* 등수별 분포 */}
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
                {TIER_ORDER.map((tier) => {
                  const count = lineGroupsByTier[tier].length;
                  if (count === 0) return null;
                  const pct = bulkTickets.length > 0 ? (count / bulkTickets.length) * 100 : 0;
                  return (
                    <Chip
                      key={tier}
                      size="small"
                      label={`${tier}: ${count}장 (${pct.toFixed(2)}%)`}
                      sx={{
                        bgcolor: TIER_COLORS[tier],
                        color: '#fff',
                        fontWeight: 700,
                      }}
                    />
                  );
                })}
              </Stack>

              {/* 등수별 상세 (스크롤 + 토글) */}
              {TIER_ORDER.map((tier) => {
                const tickets = lineGroupsByTier[tier];
                if (tickets.length === 0) return null;
                const isExpanded = expandedTiers[tier];
                return (
                  <Box key={tier} sx={{ mb: 1 }}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      spacing={0.75}
                      sx={{ mb: 0.5, cursor: 'pointer' }}
                      onClick={() => toggleTier(tier)}
                    >
                      <Box
                        sx={{
                          bgcolor: TIER_COLORS[tier],
                          color: '#fff',
                          px: 0.75,
                          py: 0.25,
                          borderRadius: 0.5,
                          fontSize: 12,
                          fontWeight: 700,
                          minWidth: 50,
                          textAlign: 'center',
                        }}
                      >
                        {tier}
                      </Box>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                        {tickets.length}장
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {isExpanded ? '▼ 접기' : '▶ 펼치기'}
                      </Typography>
                    </Stack>
                    {isExpanded && (
                      <Box
                        sx={{
                          maxHeight: 240,
                          overflowY: 'auto',
                          bgcolor: 'action.hover',
                          borderRadius: 1,
                          p: 0.75,
                        }}
                      >
                        <Stack spacing={0.5}>
                          {tickets.map((t) => (
                            <Stack
                              key={`tier-${tier}-${t.idx}`}
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                              flexWrap="wrap"
                              useFlexGap
                            >
                              <Typography
                                variant="caption"
                                sx={{
                                  minWidth: 40,
                                  color: 'text.secondary',
                                  fontWeight: 600,
                                }}
                              >
                                #{t.idx + 1}
                              </Typography>
                              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                                {t.ticket.map((n) => {
                                  const isMatched = t.matchedNumbers.includes(n);
                                  return (
                                    <Box
                                      key={`${t.idx}-${n}`}
                                      sx={{
                                        width: 26,
                                        height: 26,
                                        borderRadius: '50%',
                                        bgcolor: isMatched ? TIER_COLORS[tier] : '#4a4f57',
                                        color: '#fff',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 11,
                                        fontWeight: 700,
                                        opacity: isMatched ? 1 : 0.55,
                                        boxShadow: isMatched ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
                                      }}
                                    >
                                      {n}
                                    </Box>
                                  );
                                })}
                              </Stack>
                              <Chip
                                size="small"
                                label={`${t.hitCount}/6${t.bonusMatch ? ' +🎁' : ''}`}
                                color={t.hitCount >= 3 ? 'success' : 'default'}
                                variant={t.hitCount >= 3 ? 'filled' : 'outlined'}
                                sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
                              />
                              {t.matchedNumbers.length > 0 && (
                                <Typography variant="caption" color="text.secondary">
                                  ({t.matchedNumbers.join(', ')})
                                </Typography>
                              )}
                            </Stack>
                          ))}
                        </Stack>
                      </Box>
                    )}
                  </Box>
                );
              })}

              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 1, display: 'block' }}
              >
                ※ 등수 헤더를 클릭하면 펼치기/접기. 회차 변경 시 즉시 재계산됩니다.
              </Typography>
            </Paper>
          )}

          {lineAnalysis === null && bulkTickets.length === 0 && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              반자동 비교 패널에 게임 줄을 입력하면(대량 입력 권장) {targetRound}회 기준
              줄별 적중 상세가 여기에 표시됩니다.
            </Alert>
          )}

          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block' }}>
            ※ 본 백테스트는 backward-looking 자기 검증입니다. 좋은 등급이 다음 회차의 예측력을 의미하지 않습니다.
            다음 회차의 1/8,145,060 확률은 변하지 않습니다.
          </Typography>
        </>
      )}

      {/* 백테스트 이력 — localStorage 영속 */}
      {history.length > 0 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="body2" fontWeight={700}>
              📒 백테스트 이력 ({history.length}건 / 최대 {BACKTEST_HISTORY_LIMIT})
            </Typography>
            <Button size="small" color="error" variant="outlined" onClick={clearHistory}>
              이력 전체 삭제
            </Button>
          </Stack>
          <Box
            sx={{
              maxHeight: 280,
              overflowY: 'auto',
              pr: 0.5,
              py: 0.5,
              bgcolor: 'action.hover',
              borderRadius: 1,
            }}
          >
            <Stack spacing={0.5} sx={{ px: 1 }}>
              {history.map((snap) => {
                const isActive = snap.round === targetRound;
                return (
                  <Stack
                    key={`snap-${snap.round}`}
                    direction="row"
                    alignItems="center"
                    spacing={0.75}
                    flexWrap="wrap"
                    useFlexGap
                    sx={{
                      p: 0.75,
                      borderRadius: 1,
                      bgcolor: isActive ? 'action.selected' : 'transparent',
                      border: isActive ? '1px solid' : 'none',
                      borderColor: 'primary.main',
                    }}
                  >
                    <Chip
                      size="small"
                      label={`${snap.round}회`}
                      variant="outlined"
                      sx={{ fontWeight: 700, minWidth: 60 }}
                    />
                    <Chip
                      size="small"
                      label={snap.grade}
                      sx={{
                        bgcolor: gradeColors[snap.grade],
                        color: '#fff',
                        fontWeight: 700,
                        minWidth: 32,
                      }}
                    />
                    <Typography variant="caption" sx={{ minWidth: 90 }}>
                      강한 {snap.strongHits}/{snap.totalStrong}
                    </Typography>
                    {snap.bonusInStrong && (
                      <Typography variant="caption" color="warning.light">🎁</Typography>
                    )}
                    <Typography
                      variant="caption"
                      color={snap.excludedHits === 0 ? 'success.light' : 'error.light'}
                      sx={{ minWidth: 70 }}
                    >
                      배제 fp {snap.excludedHits}
                    </Typography>
                    <Typography variant="caption" sx={{ minWidth: 50 }}>
                      페어 {snap.matchedPairs}
                    </Typography>
                    <Typography variant="caption" sx={{ minWidth: 60 }}>
                      트리플 {snap.matchedTriples}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1, textAlign: 'right' }}>
                      {formatRelativeTime(snap.recordedAt)}
                    </Typography>
                    {!isActive && (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setManualRound(snap.round)}
                      >
                        다시 보기
                      </Button>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            ※ 이력은 이 브라우저에만 저장됩니다. 같은 회차 백테스트는 최신값으로 덮어씁니다.
          </Typography>
        </>
      )}
    </Paper>
  );
}
