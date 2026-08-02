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
  Typography,
} from '@mui/material';
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ComboActions from '../components/ComboActions';
import LottoBall from '../components/LottoBall';
import MetricChips from '../components/MetricChips';
import { v1Api } from '../api/v1Api';
import {
  buildLuckyFortune,
  buildUnifiedFortune,
  FORTUNE_METHODS,
  fromClassicRecommend,
  fromRoundRecommend,
  fromSmartGenerate,
  type FortuneMethod,
  type FortunePickResult,
} from '../utils/fortunePickEngine';

const DISCLAIMER =
  '할매 예상번호는 통계·패턴 신호를 재미있게 섞은 참고용입니다. ' +
  '1등 확률(1/8,145,060)은 어떤 방법으로도 바뀌지 않으며, 과거 패턴이 미래 당첨을 보장하지 않습니다.';

export default function FortunePickPage() {
  const [method, setMethod] = useState<FortuneMethod>('unified');
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FortunePickResult | null>(null);

  const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta, staleTime: 60_000 });
  const temperature = useQuery({
    queryKey: ['v1-temperature-fortune'],
    queryFn: () => v1Api.getTemperature(30),
    staleTime: 120_000,
  });

  const methodMeta = useMemo(
    () => FORTUNE_METHODS.find((m) => m.id === method) ?? FORTUNE_METHODS[0],
    [method]
  );

  const hotPreview = useMemo(
    () => (temperature.data?.items ?? []).filter((i) => i.tier === 'hot').slice(0, 6),
    [temperature.data]
  );
  const coldPreview = useMemo(
    () => (temperature.data?.items ?? []).filter((i) => i.tier === 'frozen' || i.tier === 'cold').slice(0, 6),
    [temperature.data]
  );

  const handlePick = useCallback(async () => {
    setLoading(true);
    setError(null);
    const seed = Date.now() + nonce;
    try {
      let next: FortunePickResult | null = null;
      if (method === 'unified') {
        const signals = await v1Api.getPredictionSignals('current_round', seed);
        next = buildUnifiedFortune(signals, seed);
      } else if (method === 'machine') {
        const data = await v1Api.getRoundRecommend();
        next = fromRoundRecommend(data, seed);
      } else if (method === 'classic') {
        const data = await v1Api.getClassicRecommend('blend');
        next = fromClassicRecommend(data, seed);
      } else if (method === 'smart') {
        const data = await v1Api.generateSmart({ nSets: 5, lookback: 5 });
        next = fromSmartGenerate(data, meta.data?.current_round ?? meta.data?.next_round ?? 0, seed);
      } else if (method === 'lucky') {
        const temp = temperature.data ?? (await v1Api.getTemperature(30));
        next = buildLuckyFortune(
          temp.items,
          meta.data?.current_round ?? meta.data?.next_round ?? temp.latest_round + 1,
          seed
        );
      }
      if (!next || next.combos.length === 0) {
        setError('조합을 만들지 못했어요. 다시 뽑아보세요.');
        return;
      }
      setResult(next);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '번호 추출에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, [method, meta.data, nonce, temperature.data]);

  return (
    <Box>
      <Paper
        sx={{
          p: { xs: 2, md: 3 },
          mb: 2.5,
          borderRadius: 3,
          background: 'linear-gradient(135deg, #5c2d82 0%, #c94b7b 55%, #f0a04b 100%)',
          color: '#fff',
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: 40, lineHeight: 1 }}>👵</Typography>
          <Box>
            <Typography variant="h5" fontWeight={900}>
              할매 예상번호
            </Typography>
            <Typography variant="body2" sx={{ opacity: 0.92 }}>
              귀자할매처럼 한 번에 5게임 뽑기
            </Typography>
          </Box>
        </Stack>
        <Typography variant="body2" sx={{ opacity: 0.95 }}>
          대상 {meta.data?.current_round ?? meta.data?.next_round ?? '—'}회
          {meta.data ? ` · 데이터 ${meta.data.row_count}건` : ''}
        </Typography>
      </Paper>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>
          뽑기 방식
        </Typography>
        <ToggleButtonGroup
          exclusive
          value={method}
          onChange={(_, v: FortuneMethod | null) => v && setMethod(v)}
          size="small"
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0.75,
            '& .MuiToggleButton-root': {
              borderRadius: '20px !important',
              border: '1px solid',
              borderColor: 'divider',
              px: 1.5,
              py: 0.75,
              textTransform: 'none',
            },
          }}
        >
          {FORTUNE_METHODS.map((m) => (
            <ToggleButton key={m.id} value={m.id}>
              {m.emoji} {m.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {methodMeta.desc}
        </Typography>
      </Paper>

      {(hotPreview.length > 0 || coldPreview.length > 0) && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>
            오늘의 온도표 (최근 30회)
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="warning.main" fontWeight={700}>
                🔥 뜨거운 번호
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {hotPreview.map((h) => (
                  <Chip key={h.number} size="small" color="warning" variant="outlined" label={h.number} />
                ))}
              </Stack>
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="info.main" fontWeight={700}>
                ❄ 오래 쉰 번호
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {coldPreview.map((c) => (
                  <Chip key={c.number} size="small" color="info" variant="outlined" label={c.number} />
                ))}
              </Stack>
            </Box>
          </Stack>
        </Paper>
      )}

      <Button
        fullWidth
        variant="contained"
        size="large"
        onClick={() => void handlePick()}
        disabled={loading}
        sx={{
          mb: 2,
          py: 1.5,
          fontWeight: 900,
          fontSize: 18,
          borderRadius: 3,
          background: 'linear-gradient(90deg, #7b3fe4, #e85d8f)',
          '&:hover': { background: 'linear-gradient(90deg, #6935c8, #d44f7f)' },
        }}
      >
        {loading ? (
          <Stack direction="row" alignItems="center" spacing={1}>
            <CircularProgress size={22} color="inherit" />
            <span>할매가 번호 뽑는 중…</span>
          </Stack>
        ) : (
          `${methodMeta.emoji} 할매에게 번호 받기`
        )}
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {result && (
        <Box>
          <Alert
            severity="info"
            icon={<span style={{ fontSize: 22 }}>💬</span>}
            sx={{ mb: 2, borderLeft: '4px solid', borderColor: 'secondary.main' }}
          >
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.25 }}>
              할매의 한마디
            </Typography>
            {result.fortuneMessage}
          </Alert>

          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={800}>
              {result.targetRound}회 예상 5게임 · {result.methodLabel}
            </Typography>
            <Button size="small" variant="outlined" onClick={() => void handlePick()} disabled={loading}>
              다시 뽑기
            </Button>
          </Stack>
          {result.targetDrawDate && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              추첨 예정 {result.targetDrawDate}
            </Typography>
          )}

          {result.combos.map((combo, idx) => (
            <Paper
              key={`${comboKey(combo.numbers)}-${idx}`}
              sx={{
                p: 2,
                mb: 1.25,
                borderRadius: 2,
                border: '1px solid',
                borderColor: idx === 0 ? 'secondary.main' : 'divider',
                bgcolor: idx === 0 ? 'action.hover' : 'background.paper',
              }}
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'flex-start', sm: 'center' }}
              >
                <Typography sx={{ width: 32, fontWeight: 900, fontSize: 20, color: 'text.secondary' }}>
                  {idx + 1}
                </Typography>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                  {combo.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={40} />
                  ))}
                </Stack>
                <ComboActions
                  numbers={combo.numbers}
                  source="fortune"
                  label={`할매 ${result.methodLabel} ${idx + 1}게임`}
                />
              </Stack>
              <MetricChips numbers={combo.numbers} />
              {combo.hint && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {combo.hint}
                </Typography>
              )}
            </Paper>
          ))}

          <Divider sx={{ my: 2 }} />
          <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'warning.main', borderLeftWidth: 4 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Chip size="small" label="1등 확률 1 / 8,145,060" color="warning" sx={{ fontWeight: 700 }} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              {DISCLAIMER}
            </Typography>
          </Paper>
        </Box>
      )}
    </Box>
  );
}

function comboKey(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).join('-');
}
