import {
  Alert,
  Box,
  Button,  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api } from '../api/v1Api';

const LOOKBACK_OPTIONS = [5, 10, 20];

export default function GeneratorPage() {
  const [lookback, setLookback] = useState(5);
  const [excludeConsecutive, setExcludeConsecutive] = useState(false);

  const generate = useMutation({
    mutationFn: () =>
      v1Api.generateWeighted({ nSets: 6, lookback, excludeConsecutive }),
  });

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        번호 생성기
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        최근 미출현 번호에 +15% 가중치를 부여한 통계 기반 추천
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
            <Typography variant="body2" color="success.main" sx={{ mb: 1 }}>
              가중치 부여 번호: {generate.data.unseen_numbers.join(', ')}
            </Typography>
          )}
          {generate.data.combinations.map((combo, idx) => (
            <Paper key={idx} sx={{ p: 2, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ width: 24, fontWeight: 800, color: 'text.secondary' }}>
                {String.fromCharCode(65 + idx)}
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {combo.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={38} />
                ))}
              </Stack>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary" display="block">
                  합 {combo.sum_total}
                </Typography>
                <CopyButton numbers={combo.numbers} />
              </Box>
            </Paper>
          ))}
        </Box>
      )}
    </Box>
  );
}
