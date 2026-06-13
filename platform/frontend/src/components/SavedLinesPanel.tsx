/**
 * 자동(구입번호 직접입력) / 반자동 비교 양쪽에서 재사용하는
 * 저장 줄 누적 패널 + 관련 타입·상수·헬퍼.
 *
 * 입력 모델 (자동 패턴 그대로):
 *   - currentSlipLines: 현재 입력 중 용지의 줄들 (A→B→C→D→E)
 *   - slipQueue: 5줄 완성된 용지들의 누적 (ManualSlipInput[])
 *
 * 콜백:
 *   - onRemoveSlip(idx): 누적 용지 1장 통째 삭제
 *   - onRemoveCurrentLine(idx): 입력 중 1줄 삭제
 *   - onEditCurrentLine(idx): 입력 중 1줄을 picked 로 복원 (재편집)
 *   - onRemoveSlipLine(slipIdx, lineIdx): 누적 용지의 1줄 삭제
 */
import { Box, Button, Chip, IconButton, Stack, Typography } from '@mui/material';
import type { ManualSlipInput } from '../api/v1Api';
import LottoBall from './LottoBall';

export const GAME_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export type GameLabel = (typeof GAME_LABELS)[number];

export type SavedLine = { label: GameLabel; numbers: number[] };

/** SavedLine[] → ManualSlipInput (백엔드 전송 포맷). */
export function slipFromLines(lines: SavedLine[]): ManualSlipInput {
  return {
    lines: lines.map((line) => ({
      label: line.label,
      numbers: [...line.numbers].sort((a, b) => a - b),
    })),
  };
}

interface SavedLinesPanelProps {
  currentSlipLines: SavedLine[];
  slipQueue: ManualSlipInput[];
  onRemoveSlip: (index: number) => void;
  onRemoveCurrentLine: (index: number) => void;
  onEditCurrentLine: (index: number) => void;
  onRemoveSlipLine: (slipIndex: number, lineIndex: number) => void;
  /** 비어있을 때 표시할 안내문 (기본: 자동 패널 문구). */
  emptyHint?: string;
}

export default function SavedLinesPanel({
  currentSlipLines,
  slipQueue,
  onRemoveSlip,
  onRemoveCurrentLine,
  onEditCurrentLine,
  onRemoveSlipLine,
  emptyHint,
}: SavedLinesPanelProps) {
  const totalLines =
    currentSlipLines.length + slipQueue.reduce((sum, slip) => sum + slip.lines.length, 0);
  if (!totalLines) {
    return (
      <Typography variant="body2" color="text.secondary">
        {emptyHint ?? '저장된 줄이 없습니다. 번호 6개 선택 후 「줄 저장」을 누르세요.'}
      </Typography>
    );
  }
  return (
    <Stack spacing={1.5}>
      {currentSlipLines.length > 0 && (
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            입력 중 (용지 {slipQueue.length + 1} · {currentSlipLines.length}/{GAME_LABELS.length}줄)
          </Typography>
          {currentSlipLines.map((line, idx) => (
            <Stack
              key={`current-${idx}`}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ mb: 0.5 }}
            >
              <Chip label={line.label} size="small" color="primary" variant="outlined" />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {line.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
              <Button
                size="small"
                variant="text"
                onClick={() => onEditCurrentLine(idx)}
                sx={{ minWidth: 'auto', px: 1 }}
                aria-label={`${line.label}줄 수정`}
              >
                수정
              </Button>
              <IconButton
                size="small"
                onClick={() => onRemoveCurrentLine(idx)}
                aria-label={`${line.label}줄 삭제`}
              >
                ×
              </IconButton>
            </Stack>
          ))}
        </Box>
      )}
      {slipQueue.map((slip, slipIdx) => (
        <Box key={`slip-${slipIdx}`}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 0.5 }}
          >
            <Typography variant="caption" color="text.secondary">
              용지 {slipIdx + 1} (저장됨 · {slip.lines.length}줄)
            </Typography>
            <IconButton
              size="small"
              onClick={() => onRemoveSlip(slipIdx)}
              aria-label={`용지 ${slipIdx + 1} 전체 삭제`}
            >
              ×
            </IconButton>
          </Stack>
          {slip.lines.map((line, lineIdx) => (
            <Stack
              key={`${slipIdx}-${lineIdx}`}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ mb: 0.5 }}
            >
              <Chip label={line.label} size="small" variant="outlined" />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {line.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
              <IconButton
                size="small"
                onClick={() => onRemoveSlipLine(slipIdx, lineIdx)}
                aria-label={`용지 ${slipIdx + 1} ${line.label}줄 삭제`}
              >
                ×
              </IconButton>
            </Stack>
          ))}
        </Box>
      ))}
    </Stack>
  );
}
