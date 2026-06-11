import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api } from '../api/v1Api';
import {
  acValue,
  consecutivePairs,
  decadeBuckets,
  evenCount,
  highCount,
  lastDigitUnique,
  lowCount,
  oddCount,
  sumBand,
  sumTotal,
} from '../utils/comboMetrics';

const LOOKBACK_OPTIONS = [5, 10, 20];

/**
 * 생성할 조합 수. 시각적 일관성을 위해 A~E 5행 고정.
 * 변경 시 String.fromCharCode(65 + idx) 와 함께 검토할 것.
 */
const N_SETS = 5;

const HONESTY_DISCLAIMER =
  '본 추천은 과거 통계 패턴 분석 결과일 뿐이며, 수학적 독립시행인 로또의 당첨 확률(1/8,145,060)을 물리적으로 상승시키지 않습니다.';

interface MetricChipsProps {
  numbers: number[];
}

function MetricChips({ numbers }: MetricChipsProps) {
  const sum = sumTotal(numbers);
  const band = sumBand(sum);
  const oc = oddCount(numbers);
  const ec = evenCount(numbers);
  const hc = highCount(numbers);
  const lc = lowCount(numbers);
  const ac = acValue(numbers);
  const pairs = consecutivePairs(numbers);
  const ld = lastDigitUnique(numbers);
  const decades = decadeBuckets(numbers);
  const decadeStr = `${decades[0]}-${decades[1]}-${decades[2]}-${decades[3]}-${decades[4]}`;

  const sumColor: 'success' | 'info' | 'warning' =
    band === 'mid' ? 'success' : band === 'low' ? 'info' : 'warning';

  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
      <Tooltip title="6개 번호의 총합. 100~175 구간이 통계적 중앙(p10~p90)">
        <Chip size="small" label={`합 ${sum}`} color={sumColor} variant="filled" />
      </Tooltip>
      <Tooltip title="홀수:짝수 개수. 표준 분포 = 2:4, 3:3, 4:2">
        <Chip size="small" label={`홀:짝 ${oc}:${ec}`} variant="outlined" />
      </Tooltip>
      <Tooltip title={`23 이상:22 이하 개수. 표준 분포 = 2:4, 3:3, 4:2`}>
        <Chip size="small" label={`고:저 ${hc}:${lc}`} variant="outlined" />
      </Tooltip>
      <Tooltip title="Arithmetic Complexity. 등차수열 류 회피 지수 (최대 10, 1등 평균 ≈ 7.4)">
        <Chip
          size="small"
          label={`AC ${ac}`}
          variant="outlined"
          color={ac >= 7 ? 'success' : ac >= 5 ? 'default' : 'warning'}
        />
      </Tooltip>
      <Tooltip
        title={
          pairs.length === 0
            ? '연속된 번호 없음'
            : `연속 쌍: ${pairs.map((p) => p.join('-')).join(', ')}`
        }
      >
        <Chip
          size="small"
          label={pairs.length === 0 ? '연속 0' : `연속 ${pairs.length}`}
          variant="outlined"
          color={pairs.length === 0 ? 'default' : 'warning'}
        />
      </Tooltip>
      <Tooltip title="끝자리(번호 % 10) 종류 수. 3종 이상이면 일자 픽 회피">
        <Chip size="small" label={`끝자리 ${ld}종`} variant="outlined" />
      </Tooltip>
      <Tooltip title="십의자리별 개수 (1자리-10대-20대-30대-40대)">
        <Chip size="small" label={`십 ${decadeStr}`} variant="outlined" />
      </Tooltip>
    </Stack>
  );
}

export default function GeneratorPage() {
  const [lookback, setLookback] = useState(5);
  const [excludeConsecutive, setExcludeConsecutive] = useState(false);

  const generate = useMutation({
    mutationFn: () =>
      v1Api.generateWeighted({ nSets: N_SETS, lookback, excludeConsecutive }),
  });

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        번호 생성기
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        최근 미출현 번호에 +15% 가중치를 부여한 통계 기반 추천 (총 {N_SETS}조합)
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          미출현 기준 (최근 회차)
        </Typography>
        <ToggleButtonGroup
          exclusive
          value={lookback}
          onChange={(_, v) => v && setLookback(v)}
          size="small"
          sx={{ mb: 2 }}
        >
          {LOOKBACK_OPTIONS.map((opt) => (
            <ToggleButton key={opt} value={opt}>
              최근 {opt}회
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <FormControlLabel
          control={
            <Switch
              checked={excludeConsecutive}
              onChange={(e) => setExcludeConsecutive(e.target.checked)}
            />
          }
          label="연속 번호 제외"
        />
      </Paper>

      <Button
        variant="contained"
        color="warning"
        size="large"
        onClick={() => generate.mutate()}
        disabled={generate.isPending}
        sx={{ mb: 2, fontWeight: 800 }}
      >
        {generate.isPending ? <CircularProgress size={24} color="inherit" /> : '번호 생성'}
      </Button>

      {generate.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {generate.error instanceof Error ? generate.error.message : '생성 실패'}
        </Alert>
      )}

      {generate.data?.warning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {generate.data.warning}
        </Alert>
      )}

      {generate.data && (
        <Box>
          {generate.data.unseen_numbers.length > 0 && (
            <Paper
              variant="outlined"
              sx={{
                p: 1.5,
                mb: 1.5,
                borderColor: 'success.main',
                borderLeftWidth: 4,
                borderLeftStyle: 'solid',
              }}
            >
              <Typography
                variant="caption"
                color="success.light"
                display="block"
                sx={{ mb: 0.75, fontWeight: 700, letterSpacing: 0.4 }}
              >
                가중치 부여 번호 · 최근 {lookback}회 미출현 (+15%)
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {generate.data.unseen_numbers.map((n) => (
                  <Chip
                    key={n}
                    label={n}
                    size="small"
                    sx={{
                      bgcolor: 'success.dark',
                      color: 'success.contrastText',
                      fontWeight: 700,
                      minWidth: 32,
                    }}
                  />
                ))}
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                sx={{ mt: 0.75 }}
              >
                총 {generate.data.unseen_numbers.length}개
              </Typography>
            </Paper>
          )}

          {generate.data.combinations.map((combo, idx) => (
            <Paper key={idx} sx={{ p: 2, mb: 1 }}>
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
                  {String.fromCharCode(65 + idx)}
                </Typography>
                <Stack
                  direction="row"
                  spacing={0.75}
                  flexWrap="wrap"
                  useFlexGap
                  sx={{ flex: 1 }}
                >
                  {combo.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={38} />
                  ))}
                </Stack>
                <CopyButton numbers={combo.numbers} />
              </Stack>
              <MetricChips numbers={combo.numbers} />
            </Paper>
          ))}

          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            {HONESTY_DISCLAIMER}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
