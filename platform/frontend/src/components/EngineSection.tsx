/**
 * ④ 패턴 분석 엔진 공통 섹션 셸.
 * 탭·패널마다 제목/칩/한줄 의도/본문 패턴을 통일해 디렉터급 진단이 한눈에 되게 한다.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
  type ChipProps,
  type SxProps,
  type Theme,
} from '@mui/material';
import { useState, type ReactNode } from 'react';

export type EngineTone = 'neutral' | 'warning' | 'info' | 'secondary' | 'success' | 'primary';

const TONE_BORDER: Record<EngineTone, string> = {
  neutral: 'divider',
  warning: 'warning.main',
  info: 'info.main',
  secondary: 'secondary.main',
  success: 'success.main',
  primary: 'primary.main',
};

/** 엔진 전역 Chip 규격 */
export const ENGINE_CHIP_SX = { height: 20, fontSize: 10, fontWeight: 700 } as const;

/** 엔진 안 공 크기 규격 — 테이블/목록/강조 */
export const ENGINE_BALL = { table: 18, list: 22, emphasis: 28, hero: 34 } as const;

export function EngineStatusChip({ sx, ...props }: ChipProps) {
  return <Chip size="small" {...props} sx={{ ...ENGINE_CHIP_SX, ...(sx as object) }} />;
}

export function EngineSection({
  title,
  tone = 'neutral',
  chips,
  intent,
  open,
  onToggle,
  defaultOpen = true,
  collapsible = false,
  actions,
  footer,
  children,
  sx,
  id,
}: {
  title: ReactNode;
  tone?: EngineTone;
  chips?: ReactNode;
  intent?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  defaultOpen?: boolean;
  collapsible?: boolean;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  sx?: SxProps<Theme>;
  id?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = collapsible ? (isControlled ? Boolean(open) : internalOpen) : true;
  const toggle = () => {
    if (isControlled) onToggle?.();
    else setInternalOpen((v) => !v);
  };

  return (
    <Paper
      id={id}
      variant="outlined"
      sx={{
        p: 1.5,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: TONE_BORDER[tone],
        ...((sx as object) ?? {}),
      }}
    >
      <Stack
        direction="row"
        alignItems="flex-start"
        justifyContent="space-between"
        flexWrap="wrap"
        useFlexGap
        spacing={1}
        sx={{ mb: isOpen && (intent || children) ? 0.75 : 0 }}
      >
        <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" fontWeight={800} component="div" sx={{ lineHeight: 1.35 }}>
            {title}
          </Typography>
          {chips}
        </Stack>
        <Stack direction="row" alignItems="center" spacing={0.75} flexShrink={0}>
          {actions}
          {collapsible && (
            <Button size="small" variant="outlined" onClick={toggle} sx={{ minWidth: 72, height: 28 }}>
              {isOpen ? '접기 ▲' : '펼치기 ▼'}
            </Button>
          )}
        </Stack>
      </Stack>
      {isOpen && intent != null && intent !== false && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: children ? 1 : 0, lineHeight: 1.45 }}>
          {intent}
        </Typography>
      )}
      {isOpen && children}
      {isOpen && footer}
    </Paper>
  );
}

/** 섹션 안 하위 블록 — Stack spacing 으로 간격 맞출 것(기본 mt 0) */
export function EngineSubBlock({
  title,
  chips,
  tone = 'neutral',
  children,
  sx,
}: {
  title?: ReactNode;
  chips?: ReactNode;
  tone?: EngineTone;
  children?: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 1,
        bgcolor: 'action.hover',
        border: '1px solid',
        borderColor: 'divider',
        borderLeft: '3px solid',
        borderLeftColor: tone === 'neutral' ? 'text.disabled' : TONE_BORDER[tone],
        ...((sx as object) ?? {}),
      }}
    >
      {(title != null || chips != null) && (
        <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: children ? 0.75 : 0 }}>
          {title != null && (
            <Typography variant="caption" fontWeight={800} sx={{ lineHeight: 1.35 }}>
              {title}
            </Typography>
          )}
          {chips}
        </Stack>
      )}
      {children}
    </Box>
  );
}

/** 탭 상단 진단 배너 — 한눈에 무엇을 보는지 */
export function EngineTabBanner({
  title,
  intent,
  chips,
}: {
  title: string;
  intent: ReactNode;
  chips?: ReactNode;
}) {
  return (
    <Alert severity="info" icon={false} sx={{ py: 0.75 }}>
      <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 0.25 }}>
        <Typography variant="caption" fontWeight={800}>
          {title}
        </Typography>
        {chips}
      </Stack>
      <Typography variant="caption" component="div" color="text.secondary">
        {intent}
      </Typography>
    </Alert>
  );
}
