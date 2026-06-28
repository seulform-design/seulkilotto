import { useCallback, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 삭제 등 파괴적 동작이면 확인 버튼을 빨간색으로. */
  destructive?: boolean;
};

/**
 * window.confirm 대체 — Promise 기반 MUI 확인 다이얼로그.
 * 모바일 웹뷰에서 차단·무시되는 네이티브 confirm 대신 일관된 UI 제공.
 *
 * 사용:
 *   const { confirm, ConfirmDialog } = useConfirm();
 *   if (await confirm({ message: '삭제할까요?', destructive: true })) { ... }
 *   // JSX 어딘가에 {ConfirmDialog}
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setState(opts);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
  }, []);

  const ConfirmDialog = state ? (
    <Dialog open onClose={() => close(false)} maxWidth="xs" fullWidth>
      {state.title ? <DialogTitle>{state.title}</DialogTitle> : null}
      <DialogContent>
        <DialogContentText sx={{ whiteSpace: 'pre-wrap' }}>{state.message}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close(false)} color="inherit">
          {state.cancelText ?? '취소'}
        </Button>
        <Button
          onClick={() => close(true)}
          color={state.destructive ? 'error' : 'primary'}
          variant="contained"
          autoFocus
        >
          {state.confirmText ?? '확인'}
        </Button>
      </DialogActions>
    </Dialog>
  ) : null;

  return { confirm, ConfirmDialog };
}
