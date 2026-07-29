import { Chip, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const MACHINE_COLORS: Record<number, string> = { 1: '#E8570D', 2: '#0D8A3E', 3: '#2952CC' };

/**
 * 추첨기(호기) 현황 — 번호추천(③)이 아니라 ④ 후속·gap 등 메타 섹션용.
 */
export default function MachineOverviewPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const overview = useQuery({
    queryKey: ['v1-machine-overview'],
    queryFn: v1Api.getMachineOverview,
    staleTime: 60_000,
  });
  const ov = overview.data;

  if (overview.isLoading) {
    return (
      <EngineSection tone="secondary" title="추첨기(호기) 현황" id="engine-machine-overview" sx={{ mb: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          호기 이력 로딩…
        </Typography>
      </EngineSection>
    );
  }

  if (!ov) {
    return (
      <EngineSection tone="secondary" title="추첨기(호기) 현황" id="engine-machine-overview" sx={{ mb: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          호기 현황을 불러오지 못했습니다.
        </Typography>
      </EngineSection>
    );
  }

  return (
    <EngineSection
      tone="secondary"
      title="추첨기(호기) 현황"
      id="engine-machine-overview"
      collapsible
      defaultOpen={defaultOpen}
      sx={{ mb: 1.5 }}
      chips={
        <>
          <EngineStatusChip
            label={`다음 ${ov.next_round} · ${ov.next_machine}호기`}
            sx={{ bgcolor: MACHINE_COLORS[ov.next_machine], color: '#fff', fontWeight: 800 }}
          />
          <EngineStatusChip
            variant="outlined"
            color={ov.next_source === 'confirmed' ? 'success' : 'info'}
            label={ov.next_source === 'confirmed' ? '실측 확정' : '순환 예측'}
          />
        </>
      }
      intent={
        <>
          lottotapa 실측 호기 순환. 번호추천 점수와 별개 메타이며, Venus 물리 추첨기는 ③ 종합 합의에만 있습니다.
        </>
      }
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, fontSize: 10 }}>
        최신 {ov.latest_round}회 {ov.latest_machine}호기 · {ov.current_block_len}연속 → 순환상 다음{' '}
        {ov.next_in_rotation}호기
      </Typography>
      <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
        최근 호기 순환 이력
      </Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        {ov.recent_history.map((h) => (
          <Chip
            key={h.round}
            size="small"
            label={`${h.round}·${h.machine}호`}
            title={h.confirmed ? '실측 확정' : '추정'}
            sx={{
              bgcolor: MACHINE_COLORS[h.machine],
              color: '#fff',
              fontWeight: 700,
              opacity: h.confirmed ? 1 : 0.5,
              height: 22,
              fontSize: 10,
            }}
          />
        ))}
      </Stack>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {[1, 2, 3].map((m) => (
          <Chip
            key={m}
            size="small"
            variant="outlined"
            label={`${m}호기 ${ov.per_machine[String(m)]?.count ?? 0}회 (최근 ${ov.per_machine[String(m)]?.last_round ?? '-'}회)`}
            sx={{ borderColor: MACHINE_COLORS[m], color: MACHINE_COLORS[m], fontWeight: 700, height: 22, fontSize: 10 }}
          />
        ))}
      </Stack>
      <Paper variant="outlined" sx={{ p: 1, mt: 1.25 }}>
        <Typography variant="caption" sx={{ fontSize: 9.5, color: 'text.secondary' }}>
          복기 탭 Venus = 해당 회차 확정 호기 · 이번회차 Venus = 다음 회차 예상 호기. 1등 확률(1/8,145,060)은 불변.
        </Typography>
      </Paper>
    </EngineSection>
  );
}
