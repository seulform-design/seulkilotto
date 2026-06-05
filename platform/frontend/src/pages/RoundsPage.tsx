import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import LottoBall from '../components/LottoBall';
import OddEvenBar from '../components/OddEvenBar';
import { v1Api } from '../api/v1Api';

export default function RoundsPage() {
  const qc = useQueryClient();
  const [selectedRound, setSelectedRound] = useState<number | null>(null);

  const status = useQuery({
    queryKey: ['v1-upgrade-status'],
    queryFn: v1Api.getUpgradeStatus,
    refetchInterval: 60_000,
  });

  const rounds = useQuery({
    queryKey: ['v1-rounds'],
    queryFn: () => v1Api.listRounds(50),
  });

  const roundDetail = useQuery({
    queryKey: ['v1-round', selectedRound],
    queryFn: () => v1Api.getRound(selectedRound!),
    enabled: selectedRound != null,
  });

  const roundAnalysis = useQuery({
    queryKey: ['v1-round-analysis', selectedRound],
    queryFn: () => v1Api.analyzeCombination(roundDetail.data!.numbers),
    enabled: !!roundDetail.data?.numbers,
  });

  const upgrade = useMutation({
    mutationFn: () => v1Api.runUpgrade(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v1-upgrade-status'] });
      qc.invalidateQueries({ queryKey: ['v1-rounds'] });
      qc.invalidateQueries({ queryKey: ['v1-meta'] });
      qc.invalidateQueries({ queryKey: ['v1-latest'] });
      qc.invalidateQueries({ queryKey: ['v1-frequency'] });
    },
  });

  const s = status.data;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        회차 업그레이드
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        동행복권 최신 추첨을 자동 수집해 CSV·분석 데이터를 갱신합니다.
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Chip label={`로컬 최신 ${s?.latest_round ?? '—'}회`} color="primary" />
          <Chip
            label={`API 최신 ${s?.api_latest_round ?? '—'}회`}
            variant="outlined"
          />
          <Chip
            label={`대기 ${s?.pending_count ?? 0}회`}
            color={s?.pending_count ? 'warning' : 'default'}
          />
          <Chip label={`데이터 ${s?.source ?? '—'}`} size="small" />
        </Stack>

        {s?.pending_rounds && s.pending_rounds.length > 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            신규 회차: {s.pending_rounds.join(', ')}회 업그레이드 가능
          </Alert>
        )}

        {s?.api_error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            API 조회 실패: {s.api_error}
          </Alert>
        )}

        <Button
          variant="contained"
          color="success"
          onClick={() => upgrade.mutate()}
          disabled={upgrade.isPending || status.isLoading}
        >
          {upgrade.isPending ? (
            <CircularProgress size={22} color="inherit" />
          ) : (
            '최신 회차 업그레이드'
          )}
        </Button>
      </Paper>

      {upgrade.data && (
        <Alert severity={upgrade.data.ok ? 'success' : 'warning'} sx={{ mb: 2 }}>
          {upgrade.data.message ??
            `${upgrade.data.before_latest}회 → ${upgrade.data.after_latest}회 (신규 ${upgrade.data.new_rounds}건)`}
          {upgrade.data.v2_sync?.ok && ' · v2 DB 동기화 OK'}
        </Alert>
      )}
      {upgrade.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {upgrade.error instanceof Error ? upgrade.error.message : '업그레이드 실패'}
        </Alert>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          회차별 당첨 내역
        </Typography>
        {rounds.isLoading && <CircularProgress size={24} />}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <List
            dense
            sx={{
              width: { xs: '100%', md: 280 },
              maxHeight: 420,
              overflow: 'auto',
              bgcolor: '#262A30',
              borderRadius: 1,
            }}
          >
            {rounds.data?.items.map((item) => (
              <ListItemButton
                key={item.round}
                selected={selectedRound === item.round}
                onClick={() => setSelectedRound(item.round)}
              >
                <ListItemText
                  primary={`${item.round}회`}
                  secondary={item.draw_date}
                />
              </ListItemButton>
            ))}
          </List>

          <Box sx={{ flex: 1 }}>
            {!selectedRound && (
              <Typography color="text.secondary">회차를 선택하세요</Typography>
            )}
            {roundDetail.data && (
              <>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  {roundDetail.data.round}회 · {roundDetail.data.draw_date}
                </Typography>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
                  {roundDetail.data.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={40} />
                  ))}
                  <Typography sx={{ alignSelf: 'center', mx: 0.5 }}>+</Typography>
                  <LottoBall number={roundDetail.data.bonus} size={40} />
                </Stack>
                {roundAnalysis.data && (
                  <Box>
                    <OddEvenBar
                      odd={roundAnalysis.data.odd_count}
                      even={roundAnalysis.data.even_count}
                    />
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      총합 {roundAnalysis.data.sum_total} ({roundAnalysis.data.sum_band})
                    </Typography>
                  </Box>
                )}
              </>
            )}
          </Box>
        </Stack>
      </Paper>
    </Box>
  );
}
