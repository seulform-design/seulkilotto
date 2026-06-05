import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api, ClassicMethod } from '../api/v1Api';

const METHODS: { id: ClassicMethod; label: string; hint: string }[] = [
  { id: 'wilson', label: '윌슨법', hint: '안정 출현 순위' },
  { id: 'gauss', label: '가우스법', hint: '총합·홀짝 μ±σ' },
  { id: 'huygens', label: '호이겐스법', hint: '미출현 gap' },
  { id: 'fermat', label: '페르마법', hint: '동시출현 쌍' },
  { id: 'blend', label: '4법 통합', hint: '각 1게임씩' },
];

export default function ClassicRecommendPage() {
  const [method, setMethod] = useState<ClassicMethod>('blend');

  const patterns = useQuery({
    queryKey: ['v1-patterns'],
    queryFn: () => v1Api.getPatterns(),
  });

  const recommend = useQuery({
    queryKey: ['v1-classic', method],
    queryFn: () => v1Api.getClassicRecommend(method),
  });

  const data = recommend.data;
  const pat = patterns.data?.patterns;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        클래식 추천
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        윌슨·가우스·호이겐스·페르마 수학 휴리스틱 기반 5게임 (통계 참고용)
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          추천 방식
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={method}
          onChange={(_, v) => v && setMethod(v)}
          sx={{ flexWrap: 'wrap' }}
        >
          {METHODS.map((m) => (
            <ToggleButton key={m.id} value={m.id} sx={{ mb: 0.5 }}>
              {m.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          {METHODS.find((m) => m.id === method)?.hint}
        </Typography>
      </Paper>

      {pat && method !== 'blend' && pat[method] && (
        <Paper sx={{ p: 2, mb: 2, bgcolor: '#262A30' }}>
          <Typography variant="subtitle2">{pat[method].label} 패턴 요약</Typography>
          <Typography variant="body2" color="text.secondary">
            {pat[method].description}
          </Typography>
          {pat[method].top10 && (
            <Typography variant="caption" sx={{ mt: 1, display: 'block' }}>
              TOP: {pat[method].top10.slice(0, 5).map((t) => t.number).join(', ')}
            </Typography>
          )}
        </Paper>
      )}

      <Button
        variant="contained"
        color="warning"
        onClick={() => recommend.refetch()}
        disabled={recommend.isFetching}
        sx={{ mb: 2, fontWeight: 800 }}
      >
        {recommend.isFetching ? (
          <CircularProgress size={24} color="inherit" />
        ) : (
          '클래식 추천 받기'
        )}
      </Button>

      {recommend.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {recommend.error instanceof Error ? recommend.error.message : '추천 실패'}
        </Alert>
      )}
      {data?.warning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {data.warning}
        </Alert>
      )}

      {data && (
        <>
          <Paper sx={{ p: 2, mb: 2, bgcolor: '#B0D840', color: '#1A2A10' }}>
            <Typography variant="caption" fontWeight={600}>
              추천 대상
            </Typography>
            <Typography variant="h4" fontWeight={800}>
              {data.next_round}회
            </Typography>
            <Typography variant="body2">
              {data.next_draw_date} · {data.method}
            </Typography>
          </Paper>

          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            {data.compose_rule} · {data.filter_rule}
          </Typography>

          {data.combinations.map((combo, idx) => (
            <Paper key={idx} sx={{ p: 2, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ width: 22, fontWeight: 800, color: 'text.secondary' }}>
                {idx + 1}
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {combo.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={36} />
                ))}
              </Stack>
              <Box sx={{ textAlign: 'right' }}>
                {combo.pattern_label && (
                  <Typography variant="caption" color="text.secondary" display="block">
                    {combo.pattern_label}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  합{combo.sum_total}
                </Typography>
                <CopyButton numbers={combo.numbers} />
              </Box>
            </Paper>
          ))}
        </>
      )}
    </Box>
  );
}
