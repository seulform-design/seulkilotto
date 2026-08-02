import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ENGINE_BALL, EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api, type StatisticsSnapshot } from '../api/v1Api';

/**
 * Statistics Artifact 스냅샷·히스토리 — 재현용 아카이브.
 * 추천 점수·히어로에 연결하지 않는다.
 */
export default function StatisticsSnapshotPanel() {
  const [open, setOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [persisting, setPersisting] = useState(false);
  const qc = useQueryClient();

  const snapQ = useQuery({
    queryKey: ['v1-stats-snapshot'],
    queryFn: () => v1Api.getStatisticsSnapshot(),
    staleTime: 300_000,
    retry: 1,
    enabled: open, // ④ 펼침 시 동시요청 폭주 방지 — 이 패널 열 때만 발화
  });

  const histQ = useQuery({
    queryKey: ['v1-stats-snapshot-history'],
    queryFn: () => v1Api.getStatisticsSnapshotHistory(20),
    staleTime: 120_000,
    retry: 1,
    enabled: open,
  });

  const fileQ = useQuery({
    queryKey: ['v1-stats-snapshot-file', selectedFile],
    queryFn: () => v1Api.getStatisticsSnapshotFile(selectedFile!),
    enabled: Boolean(selectedFile),
    staleTime: 300_000,
  });

  const persistNow = async () => {
    setPersisting(true);
    try {
      await v1Api.getStatisticsSnapshot({ persist: true });
      await qc.invalidateQueries({ queryKey: ['v1-stats-snapshot'] });
      await qc.invalidateQueries({ queryKey: ['v1-stats-snapshot-history'] });
    } finally {
      setPersisting(false);
    }
  };

  if (snapQ.isLoading) {
    return (
      <EngineSection tone="info" title="Statistics · Snapshot" id="learn-stats-snapshot" sx={{ mb: 2 }}>
        <LinearProgress />
      </EngineSection>
    );
  }

  if (snapQ.isError) {
    return (
      <EngineSection tone="info" title="Statistics · Snapshot" id="learn-stats-snapshot" sx={{ mb: 2 }}>
        <Alert severity="error">
          스냅샷을 불러오지 못했습니다:{' '}
          {snapQ.error instanceof Error ? snapQ.error.message : '서버 오류'}
        </Alert>
      </EngineSection>
    );
  }

  const snap = (selectedFile && fileQ.data ? fileQ.data : snapQ.data) as StatisticsSnapshot | undefined;
  if (!snap) {
    // 접힘(미조회) 상태 — 펼치면 그때 발화(④ 동시요청 폭주 방지)
    return (
      <EngineSection
        tone="info"
        title="Statistics · Snapshot"
        id="learn-stats-snapshot"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        defaultOpen={false}
        sx={{ mb: 2 }}
        chips={<EngineStatusChip color="default" label="펼치면 분석" />}
      >
        <LinearProgress />
      </EngineSection>
    );
  }

  const bands = snap.decade_bands?.labels ?? [];
  const rates = snap.decade_bands?.hit_rate_per_band ?? [];
  const rounds = snap.source?.rounds;

  return (
    <EngineSection
      tone="info"
      title="Statistics · Snapshot"
      id="learn-stats-snapshot"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        <>
          <EngineStatusChip color="success" label="점수 미연결" />
          <EngineStatusChip
            variant="outlined"
            label={
              rounds?.count != null
                ? `${rounds.from ?? '?'}–${rounds.to ?? '?'} · ${rounds.count}회`
                : `v${snap.version ?? '?'}`
            }
          />
        </>
      }
      intent={
        <>
          EPO 경험 분포·decade 밴드 고정본. Explain·필터 기준선용이며{' '}
          <strong>추천 점수에 쓰지 않습니다</strong>.
        </>
      }
    >
      {(snap.honesty || histQ.data?.honesty) && (
        <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">{snap.honesty ?? histQ.data?.honesty}</Typography>
        </Alert>
      )}

      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Chip
          size="small"
          label={`top6 baseline ${snap.baselines?.uniform_top6_hits ?? 0.8}`}
          sx={{ height: 20, fontSize: 10 }}
        />
        <Chip
          size="small"
          label={`sum p50 ${snap.empirical?.sum?.p50 ?? '—'}`}
          sx={{ height: 20, fontSize: 10 }}
        />
        <Chip
          size="small"
          label={`odd modes ${(snap.empirical?.odd_count_modes ?? []).join('/') || '—'}`}
          sx={{ height: 20, fontSize: 10 }}
        />
        <Button size="small" variant="outlined" disabled={persisting} onClick={() => void persistNow()}>
          {persisting ? '저장 중…' : '히스토리 저장'}
        </Button>
        {selectedFile && (
          <Button size="small" onClick={() => setSelectedFile(null)}>
            현재 스냅샷
          </Button>
        )}
      </Stack>

      {bands.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
            Decade hit_rate {selectedFile ? `(${selectedFile})` : '(현재)'}
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-end', minHeight: 48 }}>
            {bands.map((label, i) => {
              const rate = rates[i] ?? 0;
              const max = Math.max(0.01, ...rates);
              return (
                <Box key={label} sx={{ flex: 1, textAlign: 'center' }}>
                  <Box
                    sx={{
                      height: Math.max(ENGINE_BALL.table, (rate / max) * 40),
                      borderRadius: '3px 3px 0 0',
                      bgcolor: 'info.main',
                      opacity: 0.75,
                      mx: 'auto',
                      width: '70%',
                    }}
                  />
                  <Typography sx={{ fontSize: 9, fontWeight: 700 }}>{(rate * 100).toFixed(0)}%</Typography>
                  <Typography sx={{ fontSize: 8, color: 'text.disabled' }}>{label}</Typography>
                </Box>
              );
            })}
          </Stack>
        </Box>
      )}

      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
        히스토리 ({histQ.data?.count ?? 0}/{histQ.data?.total_files ?? 0})
      </Typography>
      {histQ.isLoading && <LinearProgress sx={{ mb: 1 }} />}
      {(histQ.data?.items?.length ?? 0) === 0 ? (
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
          저장된 스냅샷이 없습니다. [히스토리 저장]으로 누적할 수 있습니다.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>파일</TableCell>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>회차</TableCell>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>시각</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(histQ.data?.items ?? []).map((it) => (
                <TableRow
                  key={it.filename}
                  hover
                  selected={selectedFile === it.filename}
                  sx={{ cursor: 'pointer' }}
                  onClick={() => setSelectedFile(it.filename)}
                >
                  <TableCell sx={{ fontSize: 9.5, py: 0.5, maxWidth: 220 }}>
                    <Typography noWrap variant="caption" sx={{ fontSize: 9.5 }}>
                      {it.filename}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ fontSize: 10, py: 0.5 }}>{it.rounds_count ?? '—'}</TableCell>
                  <TableCell sx={{ fontSize: 9, py: 0.5, color: 'text.secondary' }}>
                    {(it.created_at ?? it.mtime ?? '—').slice(0, 19)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </EngineSection>
  );
}
