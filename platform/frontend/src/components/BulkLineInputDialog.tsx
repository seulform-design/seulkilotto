import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { parseBulkLines } from '../utils/bulkLineParser';

interface BulkLineInputDialogProps {
  open: boolean;
  onClose: () => void;
  /** 파싱 성공한 줄들의 number[][] 를 전달 */
  onConfirm: (lines: number[][]) => void;
  /** 슬립당 줄 수 (= 5). 예상 용지 수 표시에 사용. */
  linesPerSlip?: number;
}

const PLACEHOLDER = `한 줄에 6개 번호. 콤마/공백/탭 모두 OK.

예시:
1 2 3 4 5 6
7,8,9,10,11,12
A: 13, 14, 15, 16, 17, 18
1) 19 20 21 22 23 24
# 주석은 무시됨`;

export default function BulkLineInputDialog({
  open,
  onClose,
  onConfirm,
  linesPerSlip = 5,
}: BulkLineInputDialogProps) {
  const [text, setText] = useState('');

  const result = useMemo(() => parseBulkLines(text), [text]);

  const handleClose = () => {
    onClose();
  };

  const handleClear = () => setText('');

  const handleConfirm = () => {
    if (result.parsed.length === 0) return;
    onConfirm(result.parsed.map((p) => p.numbers));
    setText('');
    onClose();
  };

  const validCount = result.parsed.length;
  const errorCount = result.errors.length;
  const expectedSlips = Math.ceil(validCount / linesPerSlip);
  const lastSlipSize = validCount % linesPerSlip;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { bgcolor: 'background.paper' } }}
    >
      <DialogTitle>
        대량 줄 입력
        <Typography variant="caption" color="text.secondary" display="block">
          텍스트 붙여넣기 → 자동 파싱 → 5줄당 1용지로 분할
        </Typography>
      </DialogTitle>
      <DialogContent>
        <TextField
          multiline
          rows={14}
          fullWidth
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          sx={{
            mb: 1.5,
            '& .MuiInputBase-input': {
              fontFamily:
                'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
              fontSize: 13,
              lineHeight: 1.5,
            },
          }}
        />

        {text && (
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Chip
              size="small"
              color="success"
              label={`유효 ${validCount}줄`}
              sx={{ fontWeight: 700 }}
            />
            {errorCount > 0 && (
              <Chip
                size="small"
                color="error"
                label={`오류 ${errorCount}줄`}
                sx={{ fontWeight: 700 }}
              />
            )}
            <Chip
              size="small"
              variant="outlined"
              label={`예상 용지 ${expectedSlips}장${
                lastSlipSize > 0 && validCount > linesPerSlip
                  ? ` (마지막 ${lastSlipSize}줄 부분 용지)`
                  : ''
              }`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`시도 ${result.attemptedLines}줄`}
            />
          </Stack>
        )}

        {errorCount > 0 && (
          <Box
            sx={{
              maxHeight: 180,
              overflow: 'auto',
              bgcolor: 'action.hover',
              borderRadius: 1,
              p: 1,
              mb: 1,
            }}
          >
            <Typography variant="caption" color="error.main" sx={{ fontWeight: 700, mb: 0.5, display: 'block' }}>
              오류 상세 (앞 20건):
            </Typography>
            {result.errors.slice(0, 20).map((e, i) => (
              <Typography
                key={i}
                variant="caption"
                color="error.light"
                sx={{ display: 'block', fontFamily: 'monospace' }}
              >
                줄 {e.lineNum}: {e.reason} — {e.raw.slice(0, 50)}
                {e.raw.length > 50 ? '...' : ''}
              </Typography>
            ))}
            {errorCount > 20 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                ... 외 {errorCount - 20}건 더 있음
              </Typography>
            )}
          </Box>
        )}

        {validCount > 0 && (
          <Box
            sx={{
              maxHeight: 140,
              overflow: 'auto',
              bgcolor: 'action.hover',
              borderRadius: 1,
              p: 1,
            }}
          >
            <Typography
              variant="caption"
              color="success.light"
              sx={{ fontWeight: 700, mb: 0.5, display: 'block' }}
            >
              미리보기 (앞 10줄):
            </Typography>
            {result.parsed.slice(0, 10).map((p, i) => (
              <Typography
                key={i}
                variant="caption"
                sx={{ display: 'block', fontFamily: 'monospace' }}
              >
                #{i + 1}: {p.numbers.join(', ')}
              </Typography>
            ))}
            {validCount > 10 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                ... 외 {validCount - 10}줄 더 있음
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {text && (
          <Button onClick={handleClear} color="inherit">
            지우기
          </Button>
        )}
        <Button onClick={handleClose}>취소</Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={validCount === 0}
        >
          {validCount > 0 ? `${validCount}줄 / ${expectedSlips}장 추가` : '추가'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
