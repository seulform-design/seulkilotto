import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useVenusMachineHeight } from '../hooks/useVenusMachineHeight';
import ComboActions from '../components/ComboActions';
import SharingBadge from '../components/SharingBadge';
import { optimizeForSharing } from '../utils/jackpotSharing';
import LottoBall from '../components/LottoBall';
import MetricChips from '../components/MetricChips';
import WalkForwardPanel from '../components/WalkForwardPanel';
import {
  buildComposite,
  simulateDrawMachine,
  GRADE_COLORS,
  GRADE_LABELS,
  SOURCE_LABELS,
  type ConsensusGrade,
} from '../utils/compositeAnalysis';
import { v1Api } from '../api/v1Api';

const HONESTY_HEADER =
  '🟡 정직성 선언: 3축(용지 1:1 전수비교·평행회차·미출수) 합의도 당첨 확률(1/8,145,060)을 변경하지 않습니다. ' +
  '물리 추첨기는 균등 물리이며(시각용), 합의 점수가 높은 6-튜플도 균등 무작위와 동일한 확률입니다.';

const HONESTY_FOOTER =
  '※ 위 5게임은 EPO 필터(합/AC/홀짝/연속)를 통과한 조합이며, 합의 등급을 가중치로 사용합니다. ' +
  '본 추천의 1등 확률은 1/8,145,060 — 다른 어떤 추천과도 동일하며, 합의 신호는 분배 인원 회피 가능성에만 영향을 줍니다.';

const GRADE_ORDER: ConsensusGrade[] = ['S', 'A', 'B', 'C', 'X'];

export default function ComposedAnalysisPage() {
  const queries = useQueries({
    queries: [
      {
        queryKey: ['composite', 'machine'],
        queryFn: () => v1Api.getRoundRecommend(),
        staleTime: 60_000,
      },
      {
        queryKey: ['composite', 'parallel'],
        queryFn: () => v1Api.getParallelRoundAnalysis(),
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
    ],
  });

  const [machineQuery, parallelQuery, temperatureQuery, photoQuery] = queries;

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.every((q) => q.isError);

  // 용지 1:1 소스는 이번회차(current_round) 데이터를 우선하되, 없고 복기(review) 데이터가
  // 있으면 그걸 쓴다(예전엔 current_round 고정이라 복기만 있는 사용자는 소스가 침묵 누락).
  const photoIntentUsed: 'review' | 'current_round' = useMemo(() => {
    const cr = photoQuery.data?.by_intent?.current_round?.final_predictions?.strong_candidates?.length ?? 0;
    const rv = photoQuery.data?.by_intent?.review?.final_predictions?.strong_candidates?.length ?? 0;
    return cr === 0 && rv > 0 ? 'review' : 'current_round';
  }, [photoQuery.data]);

  const composite = useMemo(
    () =>
      buildComposite(
        machineQuery.data ?? null,
        parallelQuery.data ?? null,
        temperatureQuery.data ?? null,
        photoQuery.data ?? null,
        photoIntentUsed
      ),
    [machineQuery.data, parallelQuery.data, temperatureQuery.data, photoQuery.data, photoIntentUsed]
  );

  const [machineSeed, setMachineSeed] = useState(1);
  const venusHeight = useVenusMachineHeight();
  const drawMachine = useMemo(
    () => simulateDrawMachine(composite, machineQuery.data ?? null, { iterations: 6000, seed: machineSeed }),
    [composite, machineQuery.data, machineSeed]
  );

  const handleRefresh = () => {
    queries.forEach((q) => q.refetch());
  };

  const sStrongNumbers = composite.byGrade.S;
  const aStrongNumbers = composite.byGrade.A;

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="h5" fontWeight={800}>
          🎯 종합 분석
        </Typography>
        <Button
          size="small"
          variant="outlined"
          onClick={handleRefresh}
          disabled={isLoading}
        >
          {isLoading ? <CircularProgress size={18} /> : '↻ 새로 합성'}
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        용지 1:1 전수비교 + 평행회차(강수·기대) + 미출수(강수·기대) — 3축 합의 + 🎰 1호기 학습 추첨기
      </Typography>

      <Alert severity="warning" sx={{ mb: 2 }} icon={false}>
        {HONESTY_HEADER}
      </Alert>

      {/* 데이터 소스 상태 */}
      <Paper sx={{ p: 2, mb: 2 }}>
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
                  ? `용지 1:1 전수비교 (${photoIntentUsed === 'review' ? '복기 대체' : '이번회차'})`
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
              machineQuery.isLoading
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
            {!composite.sourcesAvailable.oneToOne ? ' (용지분석 이번회차 탭에서 자동/반자동을 등록·저장하면 1:1 전수비교가 합쳐집니다.)' : ''}
          </Typography>
        )}
      </Paper>

      {isError && !isLoading && (
        <Alert severity="error" sx={{ mb: 2 }}>
          소스 모두 로드 실패 — 백엔드 연결을 확인하거나 새로고침 해 주세요.
        </Alert>
      )}

      {/* 합의 상위 번호 */}
      <Paper sx={{ p: 2, mb: 2 }}>
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
                    <LottoBall number={n} size={36} />
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
                    <LottoBall number={n} size={32} />
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

      {/* 🎡 물리 추첨기(예상 호기) — 실제 추첨 재현(균등 물리). 학습 예상은 아래. */}
      {drawMachine && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
            🎡 물리 추첨기 — {drawMachine.nextRound ?? '?'}회 예상 {drawMachine.machineId ?? 1}호기
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            동행복권 추첨기(Editec Venus VIII) 물리 재현 — {drawMachine.machineId ?? 1}호기로 프리셋됨.
            실제 추첨은 모든 공이 균등하므로 이 물리 추첨은 <strong>무작위 재현(시각용)</strong>이고,
            <strong> 용지분석 학습 예상은 바로 아래 🎰 학습 추첨</strong>에서 확인하세요.
          </Typography>
          <Box sx={{ borderRadius: 2, overflow: 'hidden', border: '1px solid', borderColor: 'divider', bgcolor: '#111622' }}>
            <iframe
              title="종합분석 물리 추첨기"
              src={`/venus-machine.html?v=21&m=${drawMachine.machineId ?? 1}`}
              style={{ display: 'block', width: '100%', height: venusHeight, border: 0 }}
              scrolling="no"
            />
          </Box>
          {drawMachine.representative.length === 6 && (
            <Box sx={{ mt: 1, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
              <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
                🎯 이 회차 용지분석 학습 예상 (물리 추첨과 대조용) — {drawMachine.machineId ?? 1}호기
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                {drawMachine.representative.map((n) => (
                  <LottoBall key={`pw-${n}`} number={n} size={30} />
                ))}
                <ComboActions numbers={drawMachine.representative} source="unknown" label="종합 학습 추첨 예상" />
              </Stack>
            </Box>
          )}
        </Paper>
      )}

      {/* 🎰 학습 추첨기 시뮬레이터 */}
      {drawMachine && (
        <Paper sx={{ p: 2, mb: 2, border: '1px solid', borderColor: 'warning.main' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              🎰 {drawMachine.machineId ?? '1'}호기 학습 추첨 (용지분석 가중)
            </Typography>
            <Button size="small" variant="outlined" onClick={() => setMachineSeed((s) => s + 1)}>
              ↻ 다시 추첨
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            <strong>용지 1:1 전수비교 · 평행회차(강수/기대) · 미출수(강수/기대)</strong>를 <strong>공 무게</strong>로 반영해{' '}
            {drawMachine.iterations.toLocaleString()}회 몬테카를로 추첨한 결과입니다.{' '}
            <strong>
              {drawMachine.nextRound ?? '?'}회
              {drawMachine.drawDate ? ` (${drawMachine.drawDate})` : ''}
              {drawMachine.machineId ? ` · 예상 ${drawMachine.machineId}호기${drawMachine.machineSource === 'estimated' ? '(추정)' : ''}` : ''}
            </strong>{' '}
            기준. 무게가 큰 번호가 더 자주 뽑히지만, 실제 추첨은 균등이라 확률은 변하지 않습니다.
          </Typography>

          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.25 }}>
            🎯 대표 추첨 조합 (가장 자주 뽑힌 6개 · 구간 균형)
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 1 }}>
            {drawMachine.representative.map((n) => (
              <LottoBall key={`rep-${n}`} number={n} size={36} />
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
                    <LottoBall key={`opt-${n}`} number={n} size={32} />
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
                <LottoBall number={r.number} size={30} />
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
                      <LottoBall key={`smp-${i}-${n}`} number={n} size={22} />
                    ))}
                  </Stack>
                ))}
              </Stack>
            </>
          )}
        </Paper>
      )}

      {/* 1~45 합의 맵 */}
      <Paper sx={{ p: 2, mb: 2 }}>
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
      <Paper sx={{ p: 2, mb: 2 }}>
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
                  <LottoBall key={n} number={n} size={36} />
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

      {/* 백테스트 검증 — 합성 전략의 historical hit rate 측정 */}
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

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block' }}>
        {HONESTY_FOOTER}
      </Typography>
    </Box>
  );
}
