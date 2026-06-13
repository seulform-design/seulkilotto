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
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import LottoBall from './LottoBall';
import {
  v1Api,
  type ComboDuplicateItem,
  type ComboDuplicatePatterns,
  type PhotoAnalysisAccumulated,
} from '../api/v1Api';

interface PhotoBacktestPanelProps {
  accumulated: PhotoAnalysisAccumulated | null;
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
  const slice = accumulated?.by_intent?.current_round ?? null;
  const sliceTicketRoundStr = slice?.ticket_round?.trim();

  // 백테스트 대상 회차 결정:
  //   1) 슬라이스 ticket_round 가 latest_round 이하 (이미 추첨됨) → 그것
  //   2) ticket_round 가 미래 회차 (미추첨) → latest_round 폴백
  //   3) ticket_round 없음 → latest_round
  // 이렇게 해야 사용자가 '이번회차 예측' (= 다음 회차) 으로 만든 ticket_round
  // 가 아직 미추첨일 때 무용한 404 호출이 발생하지 않음.
  const latestRound = meta.data?.latest_round ?? null;
  const targetRound = useMemo(() => {
    if (!latestRound) return null;
    if (sliceTicketRoundStr) {
      const parsed = Number(sliceTicketRoundStr);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= latestRound) {
        return parsed; // 이미 추첨된 회차만 백테스트
      }
      // ticket_round 가 미래 (미추첨) → latest_round 폴백
    }
    return latestRound;
  }, [sliceTicketRoundStr, latestRound]);

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

  // 백테스트 가능성 판정:
  //   - 슬라이스가 존재해야 함
  //   - 대상 회차가 결정되어야 함
  //   - 대상 회차가 실제 추첨됐어야 함 (round.data 가 winning numbers 보유)
  const hasSlice = !!slice && (slice.total_analyses ?? 0) > 0;
  const roundDrawn = !!round.data && round.data.numbers?.length === 6;

  // 분석 계산
  const analysis = useMemo(() => {
    if (!hasSlice || !roundDrawn || !round.data || !accumulated) return null;

    const winning: number[] = round.data.numbers;
    const bonus: number = round.data.bonus;
    const winningSet = new Set<number>(winning);
    // PhotoAnalysisIntentSlice 에는 final_predictions 가 없어 루트 accumulated 의 것을 사용.
    // 사용자가 current_round 작업을 절대 다수로 했으면 루트 ≈ current_round 누적.
    const strongCandidates: number[] = accumulated.final_predictions?.strong_candidates ?? [];
    const excludedCandidates: number[] = accumulated.final_predictions?.excluded_candidates ?? [];

    const strongHits = strongCandidates.filter((n: number) => winningSet.has(n));
    const strongMisses = strongCandidates.filter((n: number) => !winningSet.has(n));
    const excludedHits = excludedCandidates.filter((n: number) => winningSet.has(n));
    const bonusInStrong = strongCandidates.includes(bonus);
    const bonusInExcluded = excludedCandidates.includes(bonus);

    // 콤보 매치: 당첨 조합 안에 누적 자주-페어/트리플/쿼드가 통째로 들어 있는지
    const comboPatterns = slice?.accumulated_combo_patterns ?? accumulated.accumulated_combo_patterns;
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
    };
  }, [hasSlice, roundDrawn, round.data, slice, accumulated]);

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
              ? `${targetRound}회 자동 누적 ${slice?.total_analyses ?? 0}건 → 실제 결과 비교`
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

          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block' }}>
            ※ 본 백테스트는 backward-looking 자기 검증입니다. 좋은 등급이 다음 회차의 예측력을 의미하지 않습니다.
            다음 회차의 1/8,145,060 확률은 변하지 않습니다.
          </Typography>
        </>
      )}
    </Paper>
  );
}
