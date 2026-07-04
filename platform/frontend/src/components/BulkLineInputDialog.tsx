import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import React, { useMemo, useState } from 'react';
import { parseBulkLines, type ParseError } from '../utils/bulkLineParser';

interface BulkLineInputDialogProps {
  open: boolean;
  onClose: () => void;
  /** 파싱 성공한 줄들의 number[][] 를 전달 */
  onConfirm: (lines: number[][]) => void;
  /** 슬립당 줄 수 (= 5). 예상 용지 수 표시에 사용. */
  linesPerSlip?: number;
  /** 이 대량입력이 등록되는 픽 타입 라벨 (예: '자동' / '반자동'). 제목에 표시. */
  pickTypeLabel?: string;
  /** 이미 저장된 누적 줄 키 집합 (정렬번호 '-' 조인). 겹침 검증·경고에 사용. */
  existingKeys?: Set<string>;
}

/** 번호 배열 → 정렬 '-' 조인 키. 겹침 비교 공통 규칙. */
export function lineKey(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).join('-');
}

const PLACEHOLDER = `한 줄에 6개 번호. 콤마/공백/탭 모두 OK.

예시:
1 2 3 4 5 6
7,8,9,10,11,12
A: 13, 14, 15, 16, 17, 18
1) 19 20 21 22 23 24
# 주석은 무시됨`;

// ── 텍스트 라인 조작 헬퍼 ───────────────────────────────────────
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function deleteLineAt(text: string, lineNum: number): string {
  const lines = splitLines(text);
  if (lineNum < 1 || lineNum > lines.length) return text;
  lines.splice(lineNum - 1, 1);
  return joinLines(lines);
}

function replaceLineAt(text: string, lineNum: number, newLine: string): string {
  const lines = splitLines(text);
  if (lineNum < 1 || lineNum > lines.length) return text;
  lines[lineNum - 1] = newLine;
  return joinLines(lines);
}

// ── 오류 행 컴포넌트 ─────────────────────────────────────────────
interface ErrorRowProps {
  error: ParseError;
  onDelete: () => void;
  onEdit: (newText: string) => void;
}

function ErrorRow({ error, onDelete, onEdit }: ErrorRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(error.raw);

  const startEdit = () => {
    setDraft(error.raw);
    setEditing(true);
  };

  const applyEdit = () => {
    onEdit(draft);
    setEditing(false);
  };

  const cancelEdit = () => {
    setDraft(error.raw);
    setEditing(false);
  };

  if (editing) {
    return (
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ mb: 0.5, py: 0.5 }}
      >
        <Chip
          size="small"
          label={`줄 ${error.lineNum}`}
          color="error"
          sx={{ flexShrink: 0, fontWeight: 700 }}
        />
        <TextField
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          fullWidth
          sx={{
            '& .MuiInputBase-input': {
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              fontSize: 13,
            },
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyEdit();
            if (e.key === 'Escape') cancelEdit();
          }}
        />
        <Button type="button" size="small" variant="contained" onClick={applyEdit} sx={{ flexShrink: 0 }}>
          적용
        </Button>
        <Button type="button" size="small" onClick={cancelEdit} sx={{ flexShrink: 0 }}>
          취소
        </Button>
      </Stack>
    );
  }

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{ mb: 0.5, py: 0.5 }}
    >
      <Chip
        size="small"
        label={`줄 ${error.lineNum}`}
        color="error"
        sx={{ flexShrink: 0, fontWeight: 700 }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="caption"
          color="error.light"
          sx={{ display: 'block', fontWeight: 600 }}
        >
          {error.reason}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {error.raw || '(빈 줄)'}
        </Typography>
      </Box>
      <Button type="button" size="small" variant="text" onClick={startEdit} sx={{ flexShrink: 0, minWidth: 'auto', px: 1 }}>
        수정
      </Button>
      <IconButton
        type="button"
        size="small"
        onClick={onDelete}
        aria-label={`줄 ${error.lineNum} 삭제`}
        sx={{ flexShrink: 0 }}
      >
        ×
      </IconButton>
    </Stack>
  );
}

// ── 메인 다이얼로그 ──────────────────────────────────────────────
export default function BulkLineInputDialog({
  open,
  onClose,
  onConfirm,
  linesPerSlip = 5,
  pickTypeLabel,
  existingKeys,
}: BulkLineInputDialogProps) {
  const [text, setText] = useState('');

  const result = useMemo(() => parseBulkLines(text), [text]);

  // 이미 저장된 누적 줄과 겹치는 입력 줄 (형식은 유효하지만 중복 등록)
  const dupWithSaved = useMemo(() => {
    if (!existingKeys || existingKeys.size === 0) return [];
    return result.parsed.filter((p) => existingKeys.has(lineKey(p.numbers)));
  }, [result.parsed, existingKeys]);

  const handleClose = () => onClose();
  const handleClear = () => setText('');

  const handleConfirm = (e?: React.MouseEvent<HTMLButtonElement>) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (result.parsed.length === 0) return;
    onConfirm(result.parsed.map((p) => p.numbers));
    setText('');
    onClose();
  };

  const handleDeleteLine = (lineNum: number) => {
    setText((prev) => deleteLineAt(prev, lineNum));
  };

  const handleEditLine = (lineNum: number, newLine: string) => {
    setText((prev) => replaceLineAt(prev, lineNum, newLine));
  };

  const handleDeleteAllErrors = () => {
    // 오류 줄을 한 번에 삭제 — 큰 번호부터 지워야 인덱스 안정
    const lineNumsDesc = [...result.errors]
      .map((e) => e.lineNum)
      .sort((a, b) => b - a);
    setText((prev) => {
      let working = prev;
      for (const n of lineNumsDesc) {
        working = deleteLineAt(working, n);
      }
      return working;
    });
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
      PaperProps={{
        sx: { bgcolor: 'background.paper' },
        component: 'div',
      }}
    >
      <DialogTitle>
        대량 줄 입력{pickTypeLabel ? ` · ${pickTypeLabel}` : ''}
        <Typography variant="caption" color="text.secondary" display="block">
          텍스트 붙여넣기 → 자동 파싱 → 5줄당 1용지로 분할 · 오류 줄은 인라인 수정/삭제 가능
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
            {dupWithSaved.length > 0 && (
              <Chip
                size="small"
                color="warning"
                label={`이미 저장된 줄과 중복 ${dupWithSaved.length}줄`}
                sx={{ fontWeight: 700 }}
              />
            )}
            {errorCount > 0 && (
              <Button
                type="button"
                size="small"
                color="error"
                variant="outlined"
                onClick={handleDeleteAllErrors}
              >
                오류 줄 전체 삭제 ({errorCount})
              </Button>
            )}
          </Stack>
        )}

        {dupWithSaved.length > 0 && (
          <Box sx={{ bgcolor: 'action.hover', borderRadius: 1, p: 1, mb: 1 }}>
            <Typography variant="caption" color="warning.main" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
              ⚠ 이미 저장된 누적 줄과 중복 (앞 10건) — 추가는 되지만 통계에 이미 반영된 줄입니다
            </Typography>
            {dupWithSaved.slice(0, 10).map((p, i) => (
              <Typography key={i} variant="caption" sx={{ display: 'block', fontFamily: 'monospace' }}>
                {p.numbers.join(', ')}
              </Typography>
            ))}
            {dupWithSaved.length > 10 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                ... 외 {dupWithSaved.length - 10}줄 더 중복
              </Typography>
            )}
          </Box>
        )}

        {errorCount > 0 && (
          <Box
            sx={{
              maxHeight: 240,
              overflow: 'auto',
              bgcolor: 'action.hover',
              borderRadius: 1,
              p: 1,
              mb: 1,
            }}
          >
            <Typography
              variant="caption"
              color="error.main"
              sx={{ fontWeight: 700, mb: 0.5, display: 'block' }}
            >
              오류 상세 (앞 20건) — 각 줄을 수정하거나 삭제할 수 있습니다
            </Typography>
            {result.errors.slice(0, 20).map((e) => (
              <ErrorRow
                key={`${e.lineNum}-${e.raw}`}
                error={e}
                onDelete={() => handleDeleteLine(e.lineNum)}
                onEdit={(newText) => handleEditLine(e.lineNum, newText)}
              />
            ))}
            {errorCount > 20 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                ... 외 {errorCount - 20}건 더 있음 — 「오류 줄 전체 삭제」 또는 직접 수정 필요
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
          <Button type="button" onClick={handleClear} color="inherit">
            지우기
          </Button>
        )}
        <Button type="button" onClick={handleClose}>취소</Button>
        <Button
          type="button"
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
