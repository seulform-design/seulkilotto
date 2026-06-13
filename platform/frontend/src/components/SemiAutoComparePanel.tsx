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
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import BulkLineInputDialog from './BulkLineInputDialog';
import LottoBall from './LottoBall';
import {
  v1Api,
  type ManualSlipInput,
  type PhotoAnalysisAccumulated,
} from '../api/v1Api';

const NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);

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
  savedSlipOverlapMax: number; // 가장 많이 겹친 슬립 라인의 겹침 수
}

interface BulkComparisonResult {
  ticketCount: number;
  uniqueNumberCount: number;
  perTicket: BulkTicketResult[];
  hitDistribution: Record<number, number>; // 적중 개수 → 티켓 수
  avgHits: number;
  hitRates: {
    threePlus: number;
    fourPlus: number;
    fivePlus: number;
    six: number;
  };
  bestTickets: BulkTicketResult[]; // 상위 5개 (vs latest 매치 많은 순)
  excludedWarningCount: number; // 배제 후보와 2개 이상 겹친 티켓 수
}

function buildBulkComparison(
  tickets: number[][],
  slipQueue: ManualSlipInput[],
  accumulated: PhotoAnalysisAccumulated | null,
  latestNumbers: number[],
  latestBonus: number | null
): BulkComparisonResult {
  const latestSet = new Set(latestNumbers);
  const strongSet = new Set(accumulated?.final_predictions?.strong_candidates ?? []);
  const excludedSet = new Set(accumulated?.final_predictions?.excluded_candidates ?? []);

  const uniqueNumbers = new Set<number>();
  const perTicket: BulkTicketResult[] = [];
  const hitDistribution: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let totalHits = 0;
  let excludedWarningCount = 0;

  tickets.forEach((ticket, index) => {
    ticket.forEach((n) => uniqueNumbers.add(n));

    const vsLatestMatch = ticket.filter((n) => latestSet.has(n));
    const vsStrongMatch = ticket.filter((n) => strongSet.has(n));
    const vsExcludedMatch = ticket.filter((n) => excludedSet.has(n));
    const bonusMatch = latestBonus != null && ticket.includes(latestBonus);

    // 가장 큰 슬립 라인 겹침 — 빠른 계산을 위해 전체 슬립 라인 순회
    let maxSlipOverlap = 0;
    for (const slip of slipQueue) {
      for (const line of slip.lines) {
        const overlap = ticket.filter((n) => line.numbers.includes(n)).length;
        if (overlap > maxSlipOverlap) maxSlipOverlap = overlap;
      }
    }

    perTicket.push({
      index,
      ticket,
      vsLatestMatch,
      vsStrongMatch,
      vsExcludedMatch,
      bonusMatch,
      savedSlipOverlapMax: maxSlipOverlap,
    });

    const hits = vsLatestMatch.length;
    hitDistribution[hits] = (hitDistribution[hits] ?? 0) + 1;
    totalHits += hits;
    if (vsExcludedMatch.length >= 2) excludedWarningCount += 1;
  });

  const ticketCount = tickets.length;
  const avgHits = ticketCount > 0 ? totalHits / ticketCount : 0;

  const threePlus = (hitDistribution[3] + hitDistribution[4] + hitDistribution[5] + hitDistribution[6]) / ticketCount;
  const fourPlus = (hitDistribution[4] + hitDistribution[5] + hitDistribution[6]) / ticketCount;
  const fivePlus = (hitDistribution[5] + hitDistribution[6]) / ticketCount;
  const six = hitDistribution[6] / ticketCount;

  // 상위 5개 — vs latest 매치 많은 순 (보너스 매치는 가산)
  const bestTickets = [...perTicket]
    .sort((a, b) => {
      const aScore = a.vsLatestMatch.length + (a.bonusMatch ? 0.5 : 0);
      const bScore = b.vsLatestMatch.length + (b.bonusMatch ? 0.5 : 0);
      return bScore - aScore;
    })
    .slice(0, 5);

  return {
    ticketCount,
    uniqueNumberCount: uniqueNumbers.size,
    perTicket,
    hitDistribution,
    avgHits,
    hitRates: { threePlus, fourPlus, fivePlus, six },
    bestTickets,
    excludedWarningCount,
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
  const [picked, setPicked] = useState<number[]>([]);
  const [pickFlags, setPickFlags] = useState<Record<number, PickType>>({});
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTickets, setBulkTickets] = useState<number[][]>([]);

  const latest = useQuery({
    queryKey: ['v1-latest-for-semi-auto'],
    queryFn: v1Api.getLatestDraw,
    staleTime: 60_000,
  });

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

  const bulkComparison = useMemo(
    () =>
      bulkTickets.length > 0
        ? buildBulkComparison(
            bulkTickets,
            slipQueue,
            accumulated,
            latest.data?.numbers ?? [],
            latest.data?.bonus ?? null
          )
        : null,
    [bulkTickets, slipQueue, accumulated, latest.data]
  );

  const handleBulkInsert = (lines: number[][]) => {
    setBulkTickets(lines);
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
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              📋 대량 비교 결과 ({bulkComparison.ticketCount}장)
            </Typography>
            <Button size="small" color="error" variant="outlined" onClick={resetBulk}>
              대량 결과 초기화
            </Button>
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

          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block' }}>
            ※ 위 매치율은 과거 회차에 대한 측정값이며, 다음 회차의 당첨 확률(1/8,145,060)을 변경하지 않습니다.
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
