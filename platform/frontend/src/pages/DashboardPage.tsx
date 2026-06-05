import {

  Alert,

  Box,

  Button,

  Chip,

  CircularProgress,

  Paper,

  Stack,

  TextField,

  ToggleButton,

  ToggleButtonGroup,

  Typography,

} from '@mui/material';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useState } from 'react';

import LottoBall from '../components/LottoBall';

import OddEvenBar from '../components/OddEvenBar';

import { v1Api } from '../api/v1Api';



function StatChip({ label, value }: { label: string; value: string }) {

  return (

    <Paper sx={{ flex: 1, p: 2, bgcolor: '#262A30' }}>

      <Typography variant="caption" color="text.secondary">

        {label}

      </Typography>

      <Typography variant="body1" fontWeight={700}>

        {value}

      </Typography>

    </Paper>

  );

}



export default function DashboardPage() {

  const qc = useQueryClient();

  const [recentN, setRecentN] = useState<number | 'all'>('all');

  const [inputs, setInputs] = useState(['', '', '', '', '', '']);



  const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta });
  const upgradeStatus = useQuery({
    queryKey: ['v1-upgrade-status'],
    queryFn: v1Api.getUpgradeStatus,
    staleTime: 60_000,
  });

  const latest = useQuery({ queryKey: ['v1-latest'], queryFn: v1Api.getLatestDraw });

  const frequency = useQuery({

    queryKey: ['v1-frequency', recentN],

    queryFn: () => v1Api.getFrequency(recentN === 'all' ? undefined : recentN),

  });

  const analysis = useQuery({

    queryKey: ['v1-analysis', latest.data?.numbers],

    queryFn: () => v1Api.analyzeCombination(latest.data!.numbers),

    enabled: !!latest.data?.numbers?.length,

  });



  const customAnalyze = useMutation({

    mutationFn: (numbers: number[]) => v1Api.analyzeCombination(numbers),

  });



  const draw = latest.data;

  const m = meta.data;

  const hot = frequency.data?.items.slice(0, 5) ?? [];

  const cold = frequency.data?.items.slice(-5).reverse() ?? [];



  const handleCustomAnalyze = () => {

    const nums = inputs.map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));

    if (nums.length !== 6 || new Set(nums).size !== 6) return;

    customAnalyze.mutate(nums);

  };



  return (

    <Box>

      <Typography variant="h5" fontWeight={800} gutterBottom>

        로또 분석 대시보드

      </Typography>

      {m && (

        <Typography variant="body2" color="warning.main" sx={{ mb: 1 }}>

          현재 {m.current_round}회 · 최신 추첨 {m.latest_round}회 · 데이터 {m.source}

          {m.is_complete ? ' · 전체 OK' : ''}

        </Typography>

      )}



      <Button

        size="small"

        variant="outlined"

        sx={{ mb: 2 }}

        onClick={() => {

          qc.invalidateQueries({ queryKey: ['v1-meta'] });

          qc.invalidateQueries({ queryKey: ['v1-latest'] });

          qc.invalidateQueries({ queryKey: ['v1-frequency'] });

          qc.invalidateQueries({ queryKey: ['v1-analysis'] });

        }}

      >

        새로고침

      </Button>



      {upgradeStatus.data?.can_upgrade && (
        <Alert severity="info" sx={{ mb: 2 }}>
          신규 {upgradeStatus.data.pending_count}회차 업그레이드 가능 — 「회차」 탭에서 반영하세요.
        </Alert>
      )}

      {latest.isError && (

        <Alert severity="warning" sx={{ mb: 2 }}>

          API 연결 실패 — 서버가 실행 중인지 확인하세요.

        </Alert>

      )}



      {latest.isLoading ? (

        <CircularProgress />

      ) : draw ? (

        <>

          <Paper sx={{ p: 2, mb: 2 }}>

            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>

              <Typography variant="h6">{draw.round}회 당첨 번호</Typography>

              <Typography variant="body2" color="text.secondary">

                {draw.draw_date}

              </Typography>

            </Box>

            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>

              {draw.numbers.map((n) => (

                <LottoBall key={n} number={n} />

              ))}

              <Typography sx={{ mx: 0.5, color: 'text.secondary', fontWeight: 700 }}>+</Typography>

              <LottoBall number={draw.bonus} />

              <Chip label="보너스" size="small" variant="outlined" />

            </Stack>

          </Paper>



          <Paper sx={{ p: 2, mb: 2 }}>

            <Typography variant="h6" gutterBottom>

              홀짝 비율

            </Typography>

            {analysis.isLoading && <CircularProgress size={24} />}

            {analysis.data && (

              <Box sx={{ mt: 2 }}>

                <OddEvenBar odd={analysis.data.odd_count} even={analysis.data.even_count} />

                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>

                  <StatChip

                    label="총합"

                    value={`${analysis.data.sum_total} (${analysis.data.sum_band})`}

                  />

                  <StatChip

                    label="연속 번호"

                    value={analysis.data.has_consecutive ? '있음' : '없음'}

                  />

                </Stack>

              </Box>

            )}

          </Paper>



          <Paper sx={{ p: 2, mb: 2 }}>

            <Typography variant="h6" gutterBottom>

              번호 출현 빈도

            </Typography>

            <ToggleButtonGroup

              exclusive

              size="small"

              value={recentN}

              onChange={(_, v) => v && setRecentN(v)}

              sx={{ mb: 2 }}

            >

              <ToggleButton value="all">전체</ToggleButton>

              <ToggleButton value={50}>최근 50회</ToggleButton>

              <ToggleButton value={100}>최근 100회</ToggleButton>

            </ToggleButtonGroup>

            {frequency.isLoading && <CircularProgress size={20} />}

            {frequency.data && (

              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>

                <Box sx={{ flex: 1 }}>

                  <Typography variant="caption" color="success.main">

                    HOT TOP 5

                  </Typography>

                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>

                    {hot.map((h) => (

                      <Chip key={h.number} label={`${h.number} (${h.count}회)`} size="small" />

                    ))}

                  </Stack>

                </Box>

                <Box sx={{ flex: 1 }}>

                  <Typography variant="caption" color="info.main">

                    COLD TOP 5

                  </Typography>

                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>

                    {cold.map((c) => (

                      <Chip

                        key={c.number}

                        label={`${c.number} (${c.count}회)`}

                        size="small"

                        variant="outlined"

                      />

                    ))}

                  </Stack>

                </Box>

              </Stack>

            )}

          </Paper>



          <Paper sx={{ p: 2 }}>

            <Typography variant="h6" gutterBottom>

              내 번호 분석

            </Typography>

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>

              {inputs.map((val, i) => (

                <TextField

                  key={i}

                  label={`${i + 1}`}

                  type="number"

                  size="small"

                  value={val}

                  onChange={(e) => {

                    const next = [...inputs];

                    next[i] = e.target.value;

                    setInputs(next);

                  }}

                  inputProps={{ min: 1, max: 45 }}

                  sx={{ width: 72 }}

                />

              ))}

            </Stack>

            <Button variant="contained" size="small" onClick={handleCustomAnalyze}>

              분석하기

            </Button>

            {customAnalyze.data && (

              <Box sx={{ mt: 2 }}>

                <OddEvenBar

                  odd={customAnalyze.data.odd_count}

                  even={customAnalyze.data.even_count}

                />

                <Typography variant="body2" sx={{ mt: 1 }}>

                  총합 {customAnalyze.data.sum_total} ({customAnalyze.data.sum_band}) · 연속{' '}

                  {customAnalyze.data.has_consecutive ? '있음' : '없음'}

                </Typography>

              </Box>

            )}

            {customAnalyze.isError && (

              <Alert severity="error" sx={{ mt: 1 }}>

                1~45 사이 서로 다른 6개 번호를 입력하세요.

              </Alert>

            )}

          </Paper>

        </>

      ) : null}

    </Box>

  );

}


