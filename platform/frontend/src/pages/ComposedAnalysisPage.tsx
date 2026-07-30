import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useVenusMachineHeight } from '../hooks/useVenusMachineHeight';
import ComboActions from '../components/ComboActions';
import SharingBadge from '../components/SharingBadge';
import { ExperimentalBanner } from '../components/ExplainArtifactBlock';
import { optimizeForSharing } from '../utils/jackpotSharing';
import LottoBall from '../components/LottoBall';
import { ENGINE_BALL } from '../components/EngineSection';
import MetricChips from '../components/MetricChips';
import WalkForwardPanel from '../components/WalkForwardPanel';
import {
  buildComposite,
  extractPhotoExpectedNumbers,
  simulateDrawMachine,
  GRADE_COLORS,
  GRADE_LABELS,
  SOURCE_LABELS,
  type ConsensusGrade,
  type DrawMachineMode,
  type PhotoExpectedNumber,
} from '../utils/compositeAnalysis';
import { loadDetailForecast } from '../utils/detailForecastBridge';
import { v1Api } from '../api/v1Api';

const DRAW_MODE_LABELS: Record<DrawMachineMode, string> = {
  consensus: '합의 가중',
  'photo-expected': '지지18 가중',
  'photo-pool': '지지18 풀',
};

const DETAIL_SOURCE_LABELS: Record<string, string> = {
  forecast: '상세·종합예측',
  predicted: '상세·당첨예상',
  hero: '상세·확장18커버리지',
  lines: '양쪽지지 top-18',
  merged: '양쪽지지+통합신호',
};

const HONESTY_HEADER =
  '🟡 정직성 선언: 3축(용지 1:1 전수비교·평행회차·미출수) 합의도 당첨 확률(1/8,145,060)을 변경하지 않습니다. ' +
  '물리 추첨기의 용지 예상 가중은 체험용이며, 실제 당첨 확률(1/8,145,060)은 변하지 않습니다.';

const HONESTY_FOOTER =
  '※ 위 5게임은 EPO 필터(합/AC/홀짝/연속)를 통과한 조합이며, 합의 등급을 가중치로 사용합니다. ' +
  '본 추천의 1등 확률은 1/8,145,060 — 다른 어떤 추천과도 동일하며, 합의 신호는 분배 인원 회피 가능성에만 영향을 줍니다.';

const GRADE_ORDER: ConsensusGrade[] = ['S', 'A', 'B', 'C', 'X'];

export default function ComposedAnalysisPage({
  embedded = false,
  sheetIntent = 'current_round',
}: {
  embedded?: boolean;
  sheetIntent?: 'review' | 'current_round';
} = {}) {
  const queries = useQueries({
    queries: [
      {
        queryKey: ['composite', 'machine', sheetIntent],
        // 복기 탭: 다음 회차 recommend hot 통계를 합의에 섞지 않음(아래 buildComposite에서 null).
        queryFn: () => v1Api.getRoundRecommend(),
        staleTime: 60_000,
        enabled: sheetIntent === 'current_round',
      },
      {
        queryKey: ['composite', 'machine-overview'],
        queryFn: () => v1Api.getMachineOverview(),
        staleTime: 60_000,
      },
      {
        queryKey: ['composite', 'parallel', sheetIntent],
        queryFn: async () => {
          if (sheetIntent === 'review') {
            const ov = await v1Api.getMachineOverview();
            return v1Api.getParallelRoundAnalysis(ov.latest_round);
          }
          return v1Api.getParallelRoundAnalysis();
        },
        staleTime: 60_000,
      },
      {
        queryKey: ['composite', 'temperature'],
        queryFn: () => v1Api.getTemperature(30),
        staleTime: 60_000,
      },
      {
        queryKey: ['composite', 'photo'],
        queryFn: async () => {
          try {
            return await v1Api.getPhotoAnalysisAccumulated();
          } catch {
            return null;
          }
        },
        staleTime: 60_000,
      },
      {
        // 상세분석 종합예측과 같은 통합신호 — 브리지 스냅샷 없을 때 재합성용
        queryKey: ['composite', 'prediction-signals', sheetIntent],
        queryFn: async () => {
          try {
            return await v1Api.getPredictionSignals(sheetIntent);
          } catch {
            return null;
          }
        },
        staleTime: 60_000,
      },
    ],
  });

  const [machineQuery, overviewQuery, parallelQuery, temperatureQuery, photoQuery, signalsQuery] = queries;

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.every((q) => q.isError);

  // 이번회차 Venus/합의 → current_round 용지만.
  // 복기 탭 → review 용지(해당 회차 대조용). 서로 섞지 않음.
  const photoIntentUsed = sheetIntent;

  const composite = useMemo(
    () =>
      buildComposite(
        // 복기: 다음 회차 호기 hot 가중 혼입 금지
        sheetIntent === 'review' ? null : (machineQuery.data ?? null),
        parallelQuery.data ?? null,
        temperatureQuery.data ?? null,
        photoQuery.data ?? null,
        photoIntentUsed
      ),
    [
      machineQuery.data,
      parallelQuery.data,
      temperatureQuery.data,
      photoQuery.data,
      photoIntentUsed,
      sheetIntent,
    ]
  );

  const [machineSeed, setMachineSeed] = useState(1);
  const [drawMode, setDrawMode] = useState<DrawMachineMode>('photo-expected');
  const [venusUseFavor, setVenusUseFavor] = useState(true);
  const [bridgeTick, setBridgeTick] = useState(0);
  const venusHeight = useVenusMachineHeight();

  // 용지분석 탭에서 상세분석을 본 뒤 돌아오면 스냅샷을 다시 읽는다.
  useEffect(() => {
    const bump = () => setBridgeTick((t) => t + 1);
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', bump);
    return () => {
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);

  // ① 용지분석 [상세 분석] 스냅샷(동일 브라우저) → ② 줄빈도+통합신호+평행 재합성
  const detailBridgeRaw = useMemo(() => loadDetailForecast(sheetIntent), [
    photoQuery.dataUpdatedAt,
    signalsQuery.dataUpdatedAt,
    bridgeTick,
    sheetIntent,
  ]);
  // 이번회차: 지난 회차 스냅샷이 남아 있으면 폐기. 복기: 해당 intent 스냅샷 유지.
  const detailBridge = useMemo(() => {
    if (!detailBridgeRaw) return null;
    if (sheetIntent === 'review') return detailBridgeRaw;
    const next = machineQuery.data?.next_round;
    if (next != null && detailBridgeRaw.round != null && detailBridgeRaw.round !== next) {
      return null;
    }
    return detailBridgeRaw;
  }, [detailBridgeRaw, machineQuery.data?.next_round, sheetIntent]);

  const photoExpected = useMemo((): (PhotoExpectedNumber & { detailSource?: string })[] => {
    // ① 상세분석 스냅샷 — expand18(커버리지) 우선
    if (detailBridge && detailBridge.ranked.length >= 6) {
      const pool =
        detailBridge.expand18?.length >= 6
          ? detailBridge.expand18
          : detailBridge.ranked.map((r) => r.number);
      const confOf = new Map(detailBridge.ranked.map((r) => [r.number, r.confidence]));
      return pool.slice(0, 18).map((n, i) => ({
        number: n,
        rank: i + 1,
        score: confOf.get(n) ?? Math.max(1, 18 - i),
        confidence: confOf.get(n) ?? Math.round(((18 - i) / 18) * 100),
        auto: 0,
        semi: 0,
        support: 0,
        source: 'lines' as const,
        detailSource: detailBridge.primarySource,
      }));
    }

    // ② 폴백: 양쪽 지지(고정수 제외) top-18 + 통합신호·평행 보조
    const score: Record<number, number> = {};
    const add = (n: number, w: number) => {
      if (!Number.isInteger(n) || n < 1 || n > 45 || w <= 0) return;
      score[n] = (score[n] ?? 0) + w;
    };
    const fromLines = extractPhotoExpectedNumbers(photoQuery.data ?? null, photoIntentUsed, 18);
    fromLines.forEach((p, i) => add(p.number, Math.max(4, 16 - i)));
    (signalsQuery.data?.strong_candidates ?? []).forEach((n, i) => add(n, Math.max(1.5, 6 - i * 0.35)));
    (parallelQuery.data?.parallel_strong ?? []).forEach((n, i) => add(n, Math.max(1, 4 - i * 0.3)));
    (parallelQuery.data?.parallel_expected ?? []).forEach((n, i) => add(n, Math.max(0.5, 2.5 - i * 0.2)));

    const ranked = Object.keys(score)
      .map(Number)
      .map((n) => ({ number: n, score: score[n] }))
      .sort((a, b) => b.score - a.score || a.number - b.number)
      .slice(0, 18);
    if (ranked.length >= 6) {
      const maxScore = ranked[0].score || 1;
      const lineMap = new Map(fromLines.map((p) => [p.number, p]));
      return ranked.map((r, i) => ({
        number: r.number,
        rank: i + 1,
        score: r.score,
        confidence: Math.round((r.score / maxScore) * 100),
        auto: lineMap.get(r.number)?.auto ?? 0,
        semi: lineMap.get(r.number)?.semi ?? 0,
        support: lineMap.get(r.number)?.support ?? 0,
        source: (lineMap.has(r.number) ? 'lines' : 'strong_candidates') as PhotoExpectedNumber['source'],
        detailSource: 'merged',
        fixedExcluded: fromLines[0]?.fixedExcluded,
      }));
    }
    return fromLines.map((p) => ({ ...p, detailSource: 'lines' }));
  }, [
    detailBridge,
    photoQuery.data,
    photoIntentUsed,
    signalsQuery.data,
    parallelQuery.data,
  ]);

  const photoExpectedNums = useMemo(() => photoExpected.map((p) => p.number), [photoExpected]);
  const detailSourceKey = photoExpected[0]?.detailSource ?? 'lines';
  const ov = overviewQuery.data;
  const targetRound =
    sheetIntent === 'review'
      ? (detailBridge?.round ?? ov?.latest_round ?? null)
      : (machineQuery.data?.next_round ?? detailBridge?.round ?? null);
  const machineId = (() => {
    if (sheetIntent === 'review' && targetRound != null && ov?.recent_history) {
      const hit = ov.recent_history.find((h) => h.round === targetRound);
      if (hit?.machine) return hit.machine;
      return ov.latest_machine ?? machineQuery.data?.machine_id ?? 1;
    }
    return machineQuery.data?.machine_id ?? 1;
  })();

  const effectiveDrawMode: DrawMachineMode =
    photoExpectedNums.length === 0 && drawMode !== 'consensus' ? 'consensus' : drawMode;

  const drawMachine = useMemo(
    () =>
      simulateDrawMachine(
        composite,
        sheetIntent === 'review' ? null : (machineQuery.data ?? null),
        {
          iterations: 6000,
          seed: machineSeed,
          mode: effectiveDrawMode,
          photoExpected: photoExpectedNums,
        },
      ),
    [
      composite,
      machineQuery.data,
      machineSeed,
      effectiveDrawMode,
      photoExpectedNums,
      sheetIntent,
    ],
  );

  // favor = top-18 커버리지 전체(고지지 top-6/12 집중 완화)
  const venusFavorQuery =
    venusUseFavor && photoExpectedNums.length >= 6
      ? `&favor=${photoExpectedNums.slice(0, 18).join(',')}`
      : '';

  const handleRefresh = () => {
    queries.forEach((q) => q.refetch());
  };

  const sStrongNumbers = composite.byGrade.S;
  const aStrongNumbers = composite.byGrade.A;

  const paperSx = embedded ? { p: 1.25, mb: 1.25 } : { p: 2, mb: 2 };

  return (
    <Box sx={embedded ? { '& .MuiTypography-h3': { fontSize: '1.35rem' } } : undefined}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        {!embedded && (
          <Typography variant="h5" fontWeight={800}>
            🎯 종합 분석
          </Typography>
        )}
        {embedded && (
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
            {sheetIntent === 'review' ? '복기' : '이번회차'} · 3축 합의 · Venus
          </Typography>
        )}
        <Button
          size="small"
          variant="outlined"
          onClick={handleRefresh}
          disabled={isLoading}
        >
          {isLoading ? <CircularProgress size={18} /> : '↻ 새로 합성'}
        </Button>
      </Stack>
      {!embedded && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          용지 1:1 전수비교 + 평행회차(강수·기대) + 미출수(강수·기대) — 3축 합의 + 🎰 용지 예상번호 추첨
        </Typography>
      )}

      <Alert severity="warning" sx={{ mb: embedded ? 1.25 : 2, py: 0.5 }} icon={false}>
        <Typography variant="caption">{HONESTY_HEADER}</Typography>
      </Alert>

      {/* 데이터 소스 상태 */}
      <Paper sx={paperSx}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          📡 데이터 소스 상태 (합의 {composite.sourceCount}/3)
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            color={composite.sourcesAvailable.oneToOne ? 'success' : 'warning'}
            variant={composite.sourcesAvailable.oneToOne ? 'filled' : 'outlined'}
            label={
              photoQuery.isLoading
                ? '용지 1:1 전수비교 (로딩)'
                : composite.sourcesAvailable.oneToOne
                  ? `용지 1:1 전수비교 (${sheetIntent === 'review' ? '복기' : '이번회차'})`
                  : sheetIntent === 'review'
                    ? '용지 1:1 (없음 — 복기 탭에서 용지 등록)'
                    : '용지 1:1 (없음 — 이번회차 등록 시 합쳐짐)'
            }
          />
          <Chip
            size="small"
            color={composite.sourcesAvailable.parallel ? 'success' : 'default'}
            variant={composite.sourcesAvailable.parallel ? 'filled' : 'outlined'}
            label={
              parallelQuery.isLoading
                ? '평행회차 강수·기대 (로딩)'
                : composite.sourcesAvailable.parallel
                  ? `평행회차 강수·기대 (${parallelQuery.data?.suffix_label ?? '?'})`
                  : '평행회차 (실패)'
            }
          />
          <Chip
            size="small"
            color={composite.sourcesAvailable.missing ? 'success' : 'default'}
            variant={composite.sourcesAvailable.missing ? 'filled' : 'outlined'}
            label={
              temperatureQuery.isLoading
                ? '미출수 강수·기대 (로딩)'
                : composite.sourcesAvailable.missing
                  ? '미출수 강수·기대 (gap 기준)'
                  : '미출수 (실패)'
            }
          />
          <Chip
            size="small"
            color="info"
            variant="outlined"
            label={
              sheetIntent === 'review'
                ? `Venus 호기 ${machineId}호기 (복기 확정)`
                : machineQuery.isLoading
                  ? '추첨 엔진 (로딩)'
                  : composite.sourcesAvailable.machine
                    ? `추첨 엔진 ${machineQuery.data?.machine_id ?? '?'}호기`
                    : '추첨 엔진 (실패)'
            }
          />
        </Stack>
        {composite.sourceCount < 3 && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            ※ {3 - composite.sourceCount}개 합의 소스 미가용 — 합의 등급이 낮게 산정될 수 있습니다.
            {!composite.sourcesAvailable.oneToOne
              ? sheetIntent === 'review'
                ? ' (복기 탭에서 자동/반자동을 등록하면 1:1 전수비교가 합쳐집니다.)'
                : ' (용지분석 이번회차 탭에서 자동/반자동을 등록·저장하면 1:1 전수비교가 합쳐집니다.)'
              : ''}
          </Typography>
        )}
      </Paper>

      {isError && !isLoading && (
        <Alert severity="error" sx={{ mb: 2 }}>
          소스 모두 로드 실패 — 백엔드 연결을 확인하거나 새로고침 해 주세요.
        </Alert>
      )}

      {/* 합의 상위 번호 */}
      <Paper sx={paperSx}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          🏆 합의 상위 번호
        </Typography>

        {sStrongNumbers.length > 0 && (
          <Box sx={{ mb: 1.5 }}>
            <Typography variant="caption" color="error.light" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
              S · 3+ 소스 합의 ({sStrongNumbers.length}개)
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              {sStrongNumbers.map((n) => (
                <Tooltip
                  key={n}
                  title={composite.perNumber[n].sources.map((s) => SOURCE_LABELS[s] ?? s).join(' · ')}
                >
                  <Box>
                    <LottoBall number={n} size={ENGINE_BALL.hero} />
                  </Box>
                </Tooltip>
              ))}
            </Stack>
          </Box>
        )}

        {aStrongNumbers.length > 0 && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" color="warning.light" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
              A · 2개 소스 합의 ({aStrongNumbers.length}개)
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              {aStrongNumbers.map((n) => (
                <Tooltip
                  key={n}
                  title={composite.perNumber[n].sources.map((s) => SOURCE_LABELS[s] ?? s).join(' · ')}
                >
                  <Box>
                    <LottoBall number={n} size={ENGINE_BALL.list} />
                  </Box>
                </Tooltip>
              ))}
            </Stack>
          </Box>
        )}

        {sStrongNumbers.length === 0 && aStrongNumbers.length === 0 && !isLoading && (
          <Typography variant="body2" color="text.secondary">
            현재 2개 이상 신호의 합의가 없습니다. 용지 분석을 등록하거나 다른 회차를 기다려 보세요.
          </Typography>
        )}
      </Paper>

      {/* 🎯 상세분석 예상번호 → 1호기 물리/학습 추첨기 연동 소스 */}
      <Paper sx={{ ...paperSx, border: '1px solid', borderColor: photoExpected.length ? 'success.main' : 'divider' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            🎯 {targetRound ?? '?'}회 상세분석 당첨예상번호 → {machineId}호기 추첨 소스
          </Typography>
          {photoExpected.length > 0 && (
            <Chip
              size="small"
              color={detailBridge ? 'success' : 'warning'}
              label={DETAIL_SOURCE_LABELS[detailSourceKey] ?? detailSourceKey}
            />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          복기 진단: <strong>양쪽 지지 top-18 커버리지</strong>(반자동 고정수 제외)를 추첨 풀로 씁니다.
          top-6 집중·자동 빈도는 구조적으로 약합니다.
          {detailBridge
            ? ' (상세분석 스냅샷 동기화됨)'
            : ' (상세분석 미방문 → 양쪽 지지+통합신호 재합성)'}{' '}
          아래 {machineId}호기에서 가중·풀로 뽑을 수 있습니다.
        </Typography>
        {photoExpected.length === 0 && !photoQuery.isLoading && (
          <Alert severity="info" sx={{ py: 0.5 }}>
            예상번호가 없습니다. 용지분석 → 이번회차에서 자동/반자동을 등록·저장한 뒤{' '}
            <strong>[상세 분석 모두 보기]</strong>를 한 번 열어 주세요.
          </Alert>
        )}
        {photoExpected.length > 0 && (
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="flex-start">
            {photoExpected.slice(0, 18).map((p) => (
              <Box key={`pe-${p.number}`} sx={{ textAlign: 'center', minWidth: 36 }}>
                <LottoBall number={p.number} size={ENGINE_BALL.hero} />
                <Typography variant="caption" sx={{ display: 'block', fontSize: 9, color: 'text.disabled', lineHeight: 1.1 }}>
                  #{p.rank} · {p.confidence}%
                </Typography>
              </Box>
            ))}
            {photoExpectedNums.length >= 6 && (
              <ComboActions
                numbers={
                  detailBridge?.core6?.length === 6
                    ? detailBridge.core6
                    : photoExpectedNums.slice(0, 6)
                }
                source="unknown"
                label={`${targetRound ?? '?'}회 커버리지 핵심6`}
              />
            )}
          </Stack>
        )}
        {!detailBridge && photoExpected.length > 0 && (
          <Alert severity="warning" sx={{ mt: 1, py: 0.5 }} icon={false}>
            <Typography variant="caption">
              상세분석 스냅샷과 순위가 다를 수 있습니다. 용지분석 이번회차에서 ③ 추천·상세가 계산된 뒤
              [↻ 새로 합성]을 누르면 동일 데이터로 동기화됩니다.
            </Typography>
          </Alert>
        )}
      </Paper>

      {/* 🎡 물리 추첨기 — 1234회 예상 1호기 + 상세예상 favor */}
      {drawMachine && (
        <Paper sx={paperSx}>
          <ExperimentalBanner
            show
            label="물리 추첨기·상세예상 가중은 Experimental/체험용입니다. 히어로·용지 점수에 주입하지 않으며 당첨 확률은 변하지 않습니다."
          />
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Typography variant={embedded ? 'subtitle2' : 'subtitle1'} fontWeight={700}>
              🎡 물리 추첨기 — {sheetIntent === 'review' ? '복기' : '이번회차'}{' '}
              {targetRound ?? drawMachine.nextRound ?? '?'}회 · {machineId}호기
              {sheetIntent === 'review' ? ' (확정)' : ' (예상)'}
            </Typography>
            <Tooltip title={photoExpectedNums.length < 6 ? '상세예상번호 6개 이상 필요' : '상세분석 예상번호를 물리적으로 더 잘 뜨게 함'}>
              <span>
                <Button
                  size="small"
                  variant={venusUseFavor && photoExpectedNums.length >= 6 ? 'contained' : 'outlined'}
                  color="warning"
                  disabled={photoExpectedNums.length < 6}
                  onClick={() => setVenusUseFavor((v) => !v)}
                >
                  {venusUseFavor && photoExpectedNums.length >= 6 ? '상세예상 가중 ON' : '상세예상 가중 OFF'}
                </Button>
              </span>
            </Tooltip>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            동행복권 추첨기(Editec Venus VIII) — <strong>{machineId}호기</strong> 프리셋
            {machineQuery.data?.machine_source === 'estimated' ? ' (순환 추정)' : ''}.
            {venusUseFavor && photoExpectedNums.length >= 6 ? (
              <>
                {' '}양쪽 지지 <strong>top-18 커버리지</strong>({photoExpectedNums.slice(0, 6).join(', ')}…)에{' '}
                <strong>상승·흡입 가중</strong>을 적용합니다(체험용). 실제 당첨 확률은 변하지 않습니다.
              </>
            ) : (
              <>
                {' '}균등 물리입니다. 상세예상으로 뽑으려면 가중을 켜세요.
              </>
            )}
          </Typography>
          <Box sx={{ borderRadius: 2, overflow: 'hidden', border: '1px solid', borderColor: 'divider', bgcolor: '#111622' }}>
            <iframe
              key={`venus-${machineId}-${venusFavorQuery}-${detailSourceKey}`}
              title={`${targetRound ?? '?'}회 ${machineId}호기 물리 추첨기`}
              src={`/venus-machine.html?v=24&m=${machineId}${venusFavorQuery}`}
              style={{ display: 'block', width: '100%', height: venusHeight, border: 0 }}
              scrolling="no"
            />
          </Box>
          {drawMachine.representative.length === 6 && (
            <Box sx={{ mt: 1, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
              <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
                🎯 학습 추첨 대표 조합 ({DRAW_MODE_LABELS[drawMachine.mode]}) — 물리 추첨과 대조용
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                {drawMachine.representative.map((n) => (
                  <LottoBall key={`pw-${n}`} number={n} size={ENGINE_BALL.list} />
                ))}
                <ComboActions numbers={drawMachine.representative} source="unknown" label="종합 학습 추첨 예상" />
              </Stack>
            </Box>
          )}
        </Paper>
      )}

      {/* 🎰 학습 추첨기 시뮬레이터 — ③ 임베드 시 Venus 1대만 유지(중복 제거) */}
      {drawMachine && !embedded && (
        <Paper sx={{ ...paperSx, border: '1px solid', borderColor: 'warning.main' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              🎰 {drawMachine.machineId ?? '1'}호기 학습 추첨
            </Typography>
            <Button size="small" variant="outlined" onClick={() => setMachineSeed((s) => s + 1)}>
              ↻ 다시 추첨
            </Button>
          </Stack>

          <ToggleButtonGroup
            exclusive
            size="small"
            value={effectiveDrawMode}
            onChange={(_, v: DrawMachineMode | null) => {
              if (v) setDrawMode(v);
            }}
            sx={{ mb: 1, flexWrap: 'wrap' }}
          >
            <ToggleButton value="consensus">합의 가중</ToggleButton>
            <ToggleButton value="photo-expected" disabled={photoExpectedNums.length === 0}>
              지지18 가중
            </ToggleButton>
            <ToggleButton value="photo-pool" disabled={photoExpectedNums.length < 6}>
              지지18 풀만
            </ToggleButton>
          </ToggleButtonGroup>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {effectiveDrawMode === 'photo-pool' ? (
              <>
                <strong>상세분석 예상번호 {photoExpectedNums.length}개 풀</strong>
                ({DETAIL_SOURCE_LABELS[detailSourceKey]})에서만 6개를 뽑습니다.
              </>
            ) : effectiveDrawMode === 'photo-expected' ? (
              <>
                <strong>상세분석 예상번호</strong>({DETAIL_SOURCE_LABELS[detailSourceKey]})를 공 무게로
                강하게 반영해 {machineId}호기로 추첨합니다.
              </>
            ) : (
              <>
                <strong>용지 1:1 · 평행회차 · 미출수</strong> 합의를 공 무게로 반영합니다.
              </>
            )}{' '}
            {drawMachine.iterations.toLocaleString()}회 몬테카를로 ·{' '}
            <strong>
              {targetRound ?? drawMachine.nextRound ?? '?'}회
              {drawMachine.drawDate ? ` (${drawMachine.drawDate})` : ''}
              {` · 예상 ${machineId}호기${machineQuery.data?.machine_source === 'estimated' ? '(추정)' : ''}`}
            </strong>
            . 실제 당첨 확률은 변하지 않습니다.
          </Typography>

          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
            🎯 대표 추첨 조합 (가장 자주 뽑힌 6개 · 구간 균형)
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 1 }}>
            {drawMachine.representative.map((n) => (
              <LottoBall key={`rep-${n}`} number={n} size={ENGINE_BALL.hero} />
            ))}
            <SharingBadge numbers={drawMachine.representative} />
            <ComboActions numbers={drawMachine.representative} source="unknown" label="추첨기 대표 조합" />
          </Stack>

          {/* 💰 분산(EV) 최적화 조합 — 확률은 불변, 당첨 시 공동분배 회피로 실수령 기대만 개선. */}
          {(() => {
            const opt = optimizeForSharing(drawMachine.ranked.map((r) => r.number), 12);
            if (!opt) return null;
            const same =
              opt.numbers.join(',') === [...drawMachine.representative].sort((a, b) => a - b).join(',');
            return (
              <Box sx={{ mt: 0.5, mb: 1, p: 1, borderRadius: 1, border: '1px dashed', borderColor: 'success.light', bgcolor: 'action.hover' }}>
                <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
                  💰 분산 최적화 조합 (상위 후보 중 공동당첨 위험 최소)
                </Typography>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                  {opt.numbers.map((n) => (
                    <LottoBall key={`opt-${n}`} number={n} size={ENGINE_BALL.list} />
                  ))}
                  <SharingBadge numbers={opt.numbers} />
                  <ComboActions numbers={opt.numbers} source="unknown" label="분산 최적화 조합" />
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontSize: 11 }}>
                  {same
                    ? '대표 조합이 이미 분산 최적입니다.'
                    : '예측 상위 후보를 유지하면서, 남들이 잘 안 고르는(생일·연속·규칙 패턴 회피) 6개를 골랐습니다.'}{' '}
                  <strong>당첨 확률은 대표 조합과 동일(불변)</strong>하며, 당첨 시 공동분배 인원이 적어 실수령 기대가 큽니다.
                </Typography>
              </Box>
            );
          })()}

          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
            번호별 추첨 빈도 TOP 12 (등장률 · 균등 대비 배수)
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            {drawMachine.ranked.slice(0, 12).map((r) => (
              <Box key={`dm-${r.number}`} sx={{ textAlign: 'center', minWidth: 40 }}>
                <LottoBall number={r.number} size={ENGINE_BALL.list} />
                <Typography variant="caption" sx={{ display: 'block', fontSize: 9, lineHeight: 1.1, color: 'text.disabled' }}>
                  {r.pct}%
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', fontSize: 9, lineHeight: 1, color: r.lift >= 1.3 ? 'warning.light' : 'text.disabled' }}>
                  ×{r.lift}
                </Typography>
              </Box>
            ))}
          </Stack>

          {drawMachine.samples.length > 0 && (
            <>
              <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
                이번 추첨 표본 ({drawMachine.samples.length}게임 · [다시 추첨]으로 갱신)
              </Typography>
              <Stack spacing={0.4}>
                {drawMachine.samples.map((s, i) => (
                  <Stack key={`smp-${i}`} direction="row" spacing={0.4} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="caption" sx={{ minWidth: 16, color: 'text.disabled', fontSize: 10 }}>{i + 1}</Typography>
                    {s.map((n) => (
                      <LottoBall key={`smp-${i}-${n}`} number={n} size={ENGINE_BALL.table} />
                    ))}
                  </Stack>
                ))}
              </Stack>
            </>
          )}
        </Paper>
      )}

      {/* 1~45 합의 맵 */}
      <Paper sx={paperSx}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          📊 1~45 번호 합의 맵
        </Typography>

        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          {GRADE_ORDER.map((g) => (
            <Chip
              key={g}
              size="small"
              label={`${GRADE_LABELS[g]} (${composite.byGrade[g].length}개)`}
              sx={{
                bgcolor: GRADE_COLORS[g],
                color: '#fff',
                fontWeight: 700,
              }}
            />
          ))}
        </Stack>

        <Box
          sx={{
            display: 'grid',
            // 모바일(~380px)에서 15열이면 셀이 ~20px 로 뭉개짐 → 9열로 완화.
            gridTemplateColumns: { xs: 'repeat(9, minmax(0, 1fr))', sm: 'repeat(15, minmax(0, 1fr))' },
            gap: 0.5,
            p: 1,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
          }}
        >
          {Array.from({ length: 45 }, (_, i) => i + 1).map((n) => {
            const item = composite.perNumber[n];
            const color = GRADE_COLORS[item.grade];
            return (
              <Tooltip
                key={n}
                arrow
                title={
                  <Box sx={{ whiteSpace: 'pre-line' }}>
                    {`#${n} — ${GRADE_LABELS[item.grade]}\n` +
                      (item.sources.length > 0
                        ? `우호: ${item.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ')}`
                        : '우호 신호 없음') +
                      (item.excludedBy.length > 0
                        ? `\n배제: ${item.excludedBy.map((s) => SOURCE_LABELS[s] ?? s).join(', ')}`
                        : '')}
                  </Box>
                }
              >
                <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                  <Box
                    role="img"
                    aria-label={`${n}번 — ${GRADE_LABELS[item.grade]} 등급(${item.grade})`}
                    sx={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      bgcolor: color,
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'default',
                      transition: 'transform 0.1s',
                      '&:hover': { transform: 'scale(1.1)' },
                    }}
                  >
                    {n}
                  </Box>
                  {/* 등급을 색상에만 의존하지 않도록 글자 배지(색맹/터치 보조). C(중립)는 생략 */}
                  {item.grade !== 'C' && (
                    <Box
                      aria-hidden
                      sx={{
                        position: 'absolute',
                        top: -3,
                        right: -3,
                        minWidth: 13,
                        height: 13,
                        px: '2px',
                        borderRadius: '7px',
                        bgcolor: '#000',
                        color: '#fff',
                        border: '1px solid rgba(255,255,255,0.7)',
                        fontSize: 9,
                        lineHeight: '11px',
                        fontWeight: 800,
                        textAlign: 'center',
                      }}
                    >
                      {item.grade}
                    </Box>
                  )}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      </Paper>

      {/* 합의 기반 5게임 */}
      <Paper sx={paperSx}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
          ⚙ 합의 기반 5게임
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          S 등급 우선 → A → B → 부족 시 C 폴백 · EPO 필터(합 90~195, AC≥5, 홀짝 != 0:6/6:0, 4연속 차단) 통과 조합만 채택
        </Typography>

        {composite.recommendedSets.length === 0 && !isLoading && (
          <Alert severity="info">
            합의 데이터 부족 — 5게임 생성 실패. 모든 소스가 로드된 후 재시도하세요.
          </Alert>
        )}

        {composite.recommendedSets.map((combo, idx) => (
          <Paper key={idx} sx={{ p: 1.5, mb: 1, bgcolor: 'action.hover' }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
            >
              <Typography
                sx={{
                  width: 28,
                  fontWeight: 800,
                  color: 'text.secondary',
                  flexShrink: 0,
                  fontSize: 18,
                }}
              >
                {idx + 1}
              </Typography>
              <Stack
                direction="row"
                spacing={0.75}
                flexWrap="wrap"
                useFlexGap
                sx={{ flex: 1 }}
              >
                {combo.map((n) => (
                  <LottoBall key={n} number={n} size={ENGINE_BALL.hero} />
                ))}
              </Stack>
              <ComboActions
                numbers={combo}
                source="unknown"
                label={`종합 분석 ${idx + 1}게임`}
              />
            </Stack>
            <MetricChips numbers={combo} dense />
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              {combo.map((n) => {
                const item = composite.perNumber[n];
                if (item.grade === 'C') return null;
                return (
                  <Chip
                    key={`grade-${n}`}
                    size="small"
                    label={`#${n}: ${item.grade}`}
                    sx={{
                      bgcolor: GRADE_COLORS[item.grade],
                      color: '#fff',
                      height: 18,
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  />
                );
              })}
            </Stack>
          </Paper>
        ))}
      </Paper>

      {/* 백테스트 검증 — 번호추천(③)이 아니라 ④ 검증·백테스트 탭으로 이동 */}
      {!embedded && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
            🧪 백테스트 검증
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            과거 회차로 합성 전략의 적중 분포를 측정 — 시뮬레이션 실행 후 차트 확인
          </Typography>
          <Alert severity="info" sx={{ mb: 2 }} icon={false}>
            <strong>🟡 디렉터 사전 안내:</strong> 합성 전략의 historical 평균 적중은
            통상 baseline(0.8) 과 통계적 동등이거나 약간 낮습니다 (concentration 으로
            coverage 가 줄어듦). 이는 알고리즘 부족이 아니라 게임의 본질이며,
            본 백테스트의 가치는 그 진실을 시각적으로 입증하는 것입니다.
          </Alert>
          <WalkForwardPanel
            title="종합 분석 vs 베이스라인 — Walk-Forward"
            defaultIncludeComposite
          />
        </>
      )}
      {embedded && (
        <Alert severity="info" sx={{ mt: 1.25, mb: 1, py: 0.5 }} icon={false}>
          <Typography variant="caption">
            Walk-Forward 백테스트는 <strong>④ 패턴 분석 엔진 → 검증·백테스트</strong> 탭에서 실행합니다.
            번호 추천 탭에는 합의 번호·Venus 추첨기만 둡니다.
          </Typography>
        </Alert>
      )}

      <Divider sx={{ my: embedded ? 1.25 : 2 }} />
      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block' }}>
        {HONESTY_FOOTER}
      </Typography>
    </Box>
  );
}
