/**
 * EPO (Expected Payout Optimization) 번호 생성 페이지.
 *
 * 수학적 정직 선언:
 *   - 당첨 확률은 1/8,145,060 — EPO 도 동일합니다.
 *   - 이 엔진의 목표: 역사적 분포에 정렬된 조합 + 인기 픽 회피로 기댓값 최적화.
 */
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Slider,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api, type EpoCombination, type EpoResponse } from '../api/v1Api';

// ─── 메트릭 뱃지 ──────────────────────────────────────────────────────────────
function MetricBadges({ c }: { c: EpoCombination }) {
  const sumColor =
    c.sum_total >= 100 && c.sum_total <= 175
      ? 'success'
      : c.sum_total < 100
        ? 'info'
        : 'warning';

  const acColor =
    c.ac_value >= 7 ? 'success' : c.ac_value >= 5 ? 'default' : 'warning';

  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
      <Tooltip title="6개 번호 총합 (통계 중앙: 100~175)">
        <Chip size="small" label={`합 ${c.sum_total}`} color={sumColor} />
      </Tooltip>
      <Tooltip title="홀수:짝수">
        <Chip size="small" label={`홀:짝 ${c.odd_count}:${c.even_count}`} variant="outlined" />
      </Tooltip>
      <Tooltip title="23이상:22이하">
        <Chip size="small" label={`고:저 ${c.high_count}:${c.low_count}`} variant="outlined" />
      </Tooltip>
      <Tooltip title={`Arithmetic Complexity — 역사적 1등 평균 ≈ 7.4`}>
        <Chip size="small" label={`AC ${c.ac_value}`} color={acColor} variant="outlined" />
      </Tooltip>
      <Tooltip
        title={
          c.max_consecutive_run <= 1
            ? '연속 번호 없음'
            : `최대 연속 ${c.max_consecutive_run}개`
        }
      >
        <Chip
          size="small"
          label={c.max_consecutive_run <= 1 ? '연속 0' : `연속 ${c.max_consecutive_run}`}
          color={c.max_consecutive_run >= 3 ? 'warning' : 'default'}
          variant="outlined"
        />
      </Tooltip>
      <Tooltip title="끝자리(% 10) 종류 수 — 많을수록 다양">
        <Chip size="small" label={`끝자리 ${c.last_digit_unique}종`} variant="outlined" />
      </Tooltip>
      <Tooltip title="십의자리별 분포 (1자리-10대-20대-30대-40대)">
        <Chip
          size="small"
          label={`십 ${[0,1,2,3,4].map((k) => c.decade_distribution[k] ?? 0).join('-')}`}
          variant="outlined"
        />
      </Tooltip>
      <Tooltip title="직전 회차 당첨번호와 겹치는 번호 수 (0이 이상적)">
        <Chip
          size="small"
          label={`직전 겹침 ${c.last_round_overlap}`}
          color={c.last_round_overlap === 0 ? 'default' : 'warning'}
          variant="outlined"
        />
      </Tooltip>
    </Stack>
  );
}

// ─── 파이프라인 상태 뱃지 ────────────────────────────────────────────────────
function PipelineStatusBadge({ data }: { data: EpoResponse }) {
  const isEpo = !data.backtest.fallback_active;
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
      <Chip
        label={isEpo ? '✓ EPO 모드' : '⚠ Fallback 모드'}
        color={isEpo ? 'success' : 'warning'}
        size="small"
      />
      <Chip label={`필터 통과율 ${(data.backtest.historical_pass_rate * 100).toFixed(1)}%`} size="small" variant="outlined" />
      <Chip label={`후보 ${data.pipeline.candidates_attempted}개 시도`} size="small" variant="outlined" />
      <Chip label={`적용 필터: ${data.pipeline.filters_applied.length}개`} size="small" variant="outlined" />
    </Stack>
  );
}

// ─── 프로파일 요약 ───────────────────────────────────────────────────────────
function ProfilePanel({ data }: { data: EpoResponse }) {
  const p = data.profile;
  const w = data.weights;
  return (
    <Accordion>
      <AccordionSummary expandIcon={<span>▼</span>}>
        <Typography fontWeight={700}>역사적 프로파일 · 가중치 분석</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              과거 {p.rounds_analyzed}회 통계
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>지표</TableCell>
                  <TableCell>값</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <TableRow>
                  <TableCell>합계 P10~P90</TableCell>
                  <TableCell>{p.sum_p10} ~ {p.sum_p90} (중앙값 {p.sum_p50})</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>평균 합계</TableCell>
                  <TableCell>{p.sum_mean.toFixed(1)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>홀수 최빈값</TableCell>
                  <TableCell>{p.odd_count_modes.join(', ')}개</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>고구간 최빈값</TableCell>
                  <TableCell>{p.high_count_modes.join(', ')}개</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>평균 AC</TableCell>
                  <TableCell>{p.avg_ac.toFixed(2)} (P10 = {p.p10_ac})</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              가중치 설정
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              기준 회차 {w.lookback_rounds}회 · 콜드 번호 +{(w.cold_bonus * 100).toFixed(0)}%
            </Typography>
            <Typography variant="caption" color="info.main" display="block">
              핫 번호 ({w.hot_numbers.length}개): {w.hot_numbers.slice(0, 10).join(', ')}
              {w.hot_numbers.length > 10 ? ' …' : ''}
            </Typography>
            <Typography variant="caption" color="warning.main" display="block">
              콜드 번호 ({w.cold_numbers.length}개): {w.cold_numbers.slice(0, 10).join(', ')}
              {w.cold_numbers.length > 10 ? ' …' : ''}
            </Typography>
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              자기 검증 (백테스트)
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {data.backtest.reason}
            </Typography>
            <Typography variant="caption" display="block">
              표본 {data.backtest.sample_size}개 · 통과 {data.backtest.passed_count}개 ·
              임계값 {(data.backtest.pass_threshold * 100).toFixed(0)}%
            </Typography>
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              적용된 필터
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {data.pipeline.filters_applied.map((f) => (
                <Chip key={f} label={f} size="small" variant="outlined" />
              ))}
            </Stack>
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

// ─── 파라미터 패널 ────────────────────────────────────────────────────────────
interface EpoParams {
  nSets: number;
  lookback: number;
  coldBonus: number;
  sumMin: number;
  sumMax: number;
  maxConsecutiveRun: number;
  minAcValue: number;
  maxSameDecade: number;
  enableBacktest: boolean;
}

function ParamsPanel({
  params,
  onChange,
}: {
  params: EpoParams;
  onChange: (patch: Partial<EpoParams>) => void;
}) {
  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        EPO 파라미터 설정
      </Typography>

      <Stack spacing={2.5}>
        <Box>
          <Typography variant="body2" gutterBottom>
            생성 조합 수: <b>{params.nSets}게임</b>
          </Typography>
          <Slider
            min={1} max={20} step={1} marks value={params.nSets}
            onChange={(_, v) => onChange({ nSets: v as number })}
          />
        </Box>

        <Box>
          <Typography variant="body2" gutterBottom>
            핫/콜드 기준 회차: <b>최근 {params.lookback}회</b>
          </Typography>
          <Slider
            min={5} max={100} step={5} value={params.lookback}
            marks={[{value:5,label:'5'},{value:20,label:'20'},{value:50,label:'50'},{value:100,label:'100'}]}
            onChange={(_, v) => onChange({ lookback: v as number })}
          />
        </Box>

        <Box>
          <Typography variant="body2" gutterBottom>
            콜드 번호 가중치: <b>+{(params.coldBonus * 100).toFixed(0)}%</b>
          </Typography>
          <Slider
            min={0} max={0.5} step={0.05} value={params.coldBonus}
            marks={[{value:0,label:'0%'},{value:0.15,label:'15%'},{value:0.3,label:'30%'},{value:0.5,label:'50%'}]}
            onChange={(_, v) => onChange({ coldBonus: v as number })}
          />
        </Box>

        <Box>
          <Typography variant="body2" gutterBottom>
            합계 범위: <b>{params.sumMin} ~ {params.sumMax}</b>
          </Typography>
          <Slider
            min={70} max={220} step={5}
            value={[params.sumMin, params.sumMax]}
            onChange={(_, v) => {
              const [lo, hi] = v as number[];
              onChange({ sumMin: lo, sumMax: hi });
            }}
            marks={[{value:100,label:'100'},{value:150,label:'150'},{value:175,label:'175'}]}
          />
        </Box>

        <Box>
          <Typography variant="body2" gutterBottom>
            최대 연속 번호: <b>{params.maxConsecutiveRun}개</b>
          </Typography>
          <Slider
            min={1} max={4} step={1} marks value={params.maxConsecutiveRun}
            onChange={(_, v) => onChange({ maxConsecutiveRun: v as number })}
          />
        </Box>

        <Box>
          <Typography variant="body2" gutterBottom>
            최소 AC 값: <b>{params.minAcValue}</b>
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              (역사적 1등 평균 ≈ 7.4)
            </Typography>
          </Typography>
          <Slider
            min={0} max={10} step={1} marks value={params.minAcValue}
            onChange={(_, v) => onChange({ minAcValue: v as number })}
          />
        </Box>

        <Box>
          <Typography variant="body2" gutterBottom>
            동일 십의자리 최대: <b>{params.maxSameDecade}개</b>
          </Typography>
          <Slider
            min={2} max={6} step={1} marks value={params.maxSameDecade}
            onChange={(_, v) => onChange({ maxSameDecade: v as number })}
          />
        </Box>

        <FormControlLabel
          control={
            <Switch
              checked={params.enableBacktest}
              onChange={(e) => onChange({ enableBacktest: e.target.checked })}
            />
          }
          label="자기 검증(백테스트) 활성화 — 실패 시 자동 Fallback"
        />
      </Stack>
    </Paper>
  );
}

// ─── 메인 페이지 ─────────────────────────────────────────────────────────────
const DEFAULT_PARAMS: EpoParams = {
  nSets: 5,
  lookback: 10,
  coldBonus: 0.15,
  sumMin: 100,
  sumMax: 175,
  maxConsecutiveRun: 2,
  minAcValue: 7,
  maxSameDecade: 3,
  enableBacktest: true,
};

export default function EpoPage() {
  const [params, setParams] = useState<EpoParams>(DEFAULT_PARAMS);
  const [showParams, setShowParams] = useState(false);

  const generate = useMutation({
    mutationFn: () =>
      v1Api.generateEpo({
        nSets: params.nSets,
        lookback: params.lookback,
        coldBonus: params.coldBonus,
        sumMin: params.sumMin,
        sumMax: params.sumMax,
        maxConsecutiveRun: params.maxConsecutiveRun,
        minAcValue: params.minAcValue,
        maxSameDecade: params.maxSameDecade,
        enableBacktest: params.enableBacktest,
      }),
  });

  const d = generate.data;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        EPO — 기댓값 최적화 엔진
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Multi-Stage Filter Pipeline + 자기 검증으로 역사적 분포에 정렬된 조합을 생성합니다.
        인기 픽 패턴 회피로 당첨 시 1인당 실수령액을 높이는 것이 목표입니다.
      </Typography>

      <Alert severity="warning" icon={false} sx={{ mb: 2 }}>
        <Typography variant="body2">
          ⚠️ <strong>수학적 정직 선언</strong> — 로또 6/45 당첨 확률은 1/8,145,060입니다.
          EPO 엔진도 이 확률을 물리적으로 높이지 <strong>않습니다</strong>. 이 엔진의 실제 목표는
          통계적으로 균형 잡힌 조합 생성 + 생일번호·연속번호 등 대중적 패턴 회피입니다.
        </Typography>
      </Alert>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Button
          variant="contained"
          color="warning"
          size="large"
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          sx={{ fontWeight: 800 }}
        >
          {generate.isPending ? (
            <CircularProgress size={24} color="inherit" />
          ) : (
            `EPO 생성 (${params.nSets}게임)`
          )}
        </Button>
        <Button
          variant="outlined"
          size="large"
          onClick={() => setShowParams((v) => !v)}
        >
          {showParams ? '파라미터 접기' : '⚙ 파라미터 설정'}
        </Button>
        <Button
          variant="text"
          size="small"
          onClick={() => setParams(DEFAULT_PARAMS)}
        >
          초기화
        </Button>
      </Stack>

      {showParams && (
        <ParamsPanel
          params={params}
          onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
        />
      )}

      {generate.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {generate.error instanceof Error ? generate.error.message : '생성 실패'}
        </Alert>
      )}

      {d && (
        <Box>
          <PipelineStatusBadge data={d} />

          {d.pipeline.shortfall_warning && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {d.pipeline.shortfall_warning}
            </Alert>
          )}

          {d.backtest.fallback_active && (
            <Alert severity="info" sx={{ mb: 2 }}>
              자기 검증 미통과 → Fallback 모드로 생성됐습니다. ({d.backtest.reason})
            </Alert>
          )}

          {d.combinations.map((combo, idx) => (
            <Paper key={idx} sx={{ p: 2, mb: 1.5 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'flex-start', sm: 'center' }}
              >
                <Typography
                  sx={{ width: 28, fontWeight: 800, color: 'text.secondary', fontSize: 18, flexShrink: 0 }}
                >
                  {String.fromCharCode(65 + idx)}
                </Typography>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                  {combo.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={40} />
                  ))}
                </Stack>
                <CopyButton numbers={combo.numbers} />
              </Stack>
              <MetricBadges c={combo} />
            </Paper>
          ))}

          <Divider sx={{ my: 2 }} />

          <ProfilePanel data={d} />

          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary" fontStyle="italic">
            {d.honesty.disclaimer}
          </Typography>
        </Box>
      )}

      {!d && !generate.isPending && (
        <Paper sx={{ p: 3, bgcolor: '#1C2128', border: '1px solid #33383F' }}>
          <Typography variant="subtitle2" gutterBottom fontWeight={700}>
            EPO 엔진 작동 원리
          </Typography>
          <Stack spacing={1}>
            {[
              ['1. 역사적 프로파일 구축', '전체 회차 당첨 번호의 합계·홀짝·AC값 등 분포를 학습합니다.'],
              ['2. 가중치 부여', `최근 ${params.lookback}회 미출현(콜드) 번호에 +${(params.coldBonus*100).toFixed(0)}% 가중치를 부여합니다.`],
              ['3. Multi-Stage 필터', `합계(${params.sumMin}~${params.sumMax}), AC(≥${params.minAcValue}), 연속(≤${params.maxConsecutiveRun}), 끝자리, 십의자리 등 ${6}개 필터를 순차 적용합니다.`],
              ['4. 자기 검증', params.enableBacktest ? '생성된 조합이 역사적 통과율을 만족하는지 백테스트합니다.' : '(비활성화됨)'],
              ['5. 인기 패턴 회피', '생일 번호 쏠림, 연속 번호, 동일 끝자리 과다를 제거합니다.'],
            ].map(([title, desc]) => (
              <Box key={title as string}>
                <Typography variant="body2" fontWeight={700}>{title as string}</Typography>
                <Typography variant="body2" color="text.secondary">{desc as string}</Typography>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
