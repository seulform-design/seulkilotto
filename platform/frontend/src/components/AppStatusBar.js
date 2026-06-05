import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Chip, Stack } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { v1Api } from '../api/v1Api';
export default function AppStatusBar() {
    const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta, staleTime: 60000 });
    const upgrade = useQuery({
        queryKey: ['v1-upgrade-status'],
        queryFn: v1Api.getUpgradeStatus,
        staleTime: 60000,
    });
    const m = meta.data;
    const u = upgrade.data;
    return (_jsxs(Stack, { direction: "row", spacing: 0.75, alignItems: "center", children: [m && (_jsx(Chip, { size: "small", label: `${m.latest_round}회`, sx: { bgcolor: '#33383F', color: '#FBC400', fontWeight: 700 } })), u?.can_upgrade && (_jsx(Chip, { size: "small", color: "warning", label: `+${u.pending_count}회` }))] }));
}
