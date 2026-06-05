import { Chip, Stack } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { v1Api } from '../api/v1Api';

export default function AppStatusBar() {
  const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta, staleTime: 60_000 });
  const upgrade = useQuery({
    queryKey: ['v1-upgrade-status'],
    queryFn: v1Api.getUpgradeStatus,
    staleTime: 60_000,
  });

  const m = meta.data;
  const u = upgrade.data;

  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      {m && (
        <Chip
          size="small"
          label={`${m.latest_round}회`}
          sx={{ bgcolor: '#33383F', color: '#FBC400', fontWeight: 700 }}
        />
      )}
      {u?.can_upgrade && (
        <Chip size="small" color="warning" label={`+${u.pending_count}회`} />
      )}
    </Stack>
  );
}
