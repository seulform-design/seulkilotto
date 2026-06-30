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
import { useMemo } from 'react';
import ComboActions from '../components/ComboActions';
import LottoBall from '../components/LottoBall';
import MetricChips from '../components/MetricChips';
import WalkForwardPanel from '../components/WalkForwardPanel';
import {
  buildComposite,
  GRADE_COLORS,
  GRADE_LABELS,
  SOURCE_LABELS,
  type ConsensusGrade,
} from '../utils/compositeAnalysis';
import { v1Api } from '../api/v1Api';

const HONESTY_HEADER =
  '🟡 정직성 선언: 3개 신호의 교집합도 당첨 확률(1/8,145,060)을 변경하지 않습니다. ' +
  '본 페이지는 패턴 관찰 도구이며, 합의 점수가 높은 6-튜플도 균등 무작위와 동일한 확률입니다.';

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
        queryKey: ['composite', 'post'],
        queryFn: () => v1Api.getPostOccurrenceAnalysis(),
        staleTime: 60_000,
      },
      {
        queryKey: ['composite', 'classic'],
        queryFn: () => v1Api.getClassicRecommend('blend'),
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

  const [machineQuery, postQuery, classicQuery, photoQuery] = queries;

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.every((q) => q.isError);

  const composite = useMemo(
    () =>
      buildComposite(
        machineQuery.data ?? null,
        postQuery.data ?? null,
        photoQuery.data ?? null,
        classicQuery.data ?? null,
        'current_round'
      ),
    [machineQuery.data, postQuery.data, photoQuery.data, classicQuery.data]
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
        추첨기 + 후속 출현 + 용지 분석 — 3개 독립 신호의 교집합 시각화
      </Typography>

      <Alert severity="warning" sx={{ mb: 2 }} icon={false}>
        {HONESTY_HEADER}
      </Alert>

      {/* 데이터 소스 상태 */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          📡 데이터 소스 상태 ({composite.sourceCount}/3)
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            color={composite.sourcesAvailable.machine ? 'success' : 'default'}
            variant={composite.sourcesAvailable.machine ? 'filled' : 'outlined'}
            label={
              machineQuery.isLoading
                ? '추첨기 분석 (로딩)'
                : composite.sourcesAvailable.machine
                  ? `추첨기 분석 (${machineQuery.data?.machine_id}호기)`
                  : '추첨기 분석 (실패)'
            }
          />
          <Chip
            size="small"
            color={composite.sourcesAvailable.post ? 'success' : 'default'}
            variant={composite.sourcesAvailable.post ? 'filled' : 'outlined'}
            label={
              postQuery.isLoading
                ? '후속 출현 통계 (로딩)'
                : composite.sourcesAvailable.post
                  ? `후속 출현 통계 (${postQuery.data?.meta?.trigger_round ?? '?'}회 기준)`
                  : '후속 출현 통계 (실패)'
            }
          />
          <Chip
            size="small"
            color={composite.sourcesAvailable.photo ? 'success' : 'warning'}
            variant={composite.sourcesAvailable.photo ? 'filled' : 'outlined'}
            label={
              photoQuery.isLoading
                ? '용지 분석 (로딩)'
                : composite.sourcesAvailable.photo
                  ? `용지 분석 (${photoQuery.data?.total_analyses ?? 0}건 누적)`
                  : '용지 분석 (없음 — 등록하면 합쳐짐)'
            }
          />
        </Stack>
        {composite.sourceCount < 3 && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            ※ {3 - composite.sourceCount}개 소스 미가용 — 합의 등급이 낮게 산정될 수 있습니다.
          </Typography>
        )}
      </Paper>

      {isError && !isLoading && (
        <Alert severity="error" sx={{ mb: 2 }}>
          3개 소스 모두 로드 실패 — 백엔드 연결을 확인하거나 새로고침 해 주세요.
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
              S · 3개 신호 모두 추천 ({sStrongNumbers.length}개)
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
              A · 2개 신호 합의 ({aStrongNumbers.length}개)
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
            gridTemplateColumns: 'repeat(15, minmax(0, 1fr))',
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
