import { Button, IconButton, Stack, Tooltip } from '@mui/material';
import { useState } from 'react';
import { useFavorites, type FavoriteSource } from '../hooks/useFavorites';
import { downloadBlob, formatComboText, renderComboImage, shareCombo } from '../utils/comboShare';

interface ComboActionsProps {
  numbers: number[];
  source?: FavoriteSource;
  label?: string;
  /** 액션 표시 옵션 (모두 기본 true) */
  showCopy?: boolean;
  showFavorite?: boolean;
  showImage?: boolean;
  showShare?: boolean;
  /** 콜백: 사용자에게 토스트 등으로 알릴 때 */
  onNotice?: (message: string) => void;
}

type BusyKey = 'copy' | 'fav' | 'image' | 'share';

export default function ComboActions({
  numbers,
  source = 'unknown',
  label,
  showCopy = true,
  showFavorite = true,
  showImage = true,
  showShare = true,
  onNotice,
}: ComboActionsProps) {
  const favorites = useFavorites();
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const [copied, setCopied] = useState(false);

  const isFav = favorites.has(numbers);

  const notify = (msg: string) => {
    if (onNotice) onNotice(msg);
  };

  const handleCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(formatComboText(numbers));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify('클립보드 복사 실패');
    } finally {
      setBusy(null);
    }
  };

  const handleFavorite = () => {
    if (isFav) {
      const target = favorites.list.find((f) => {
        const sortedA = [...f.numbers].sort((a, b) => a - b).join('-');
        const sortedB = [...numbers].sort((a, b) => a - b).join('-');
        return sortedA === sortedB;
      });
      if (target) {
        favorites.remove(target.id);
        notify('즐겨찾기에서 제거됨');
      }
      return;
    }
    const res = favorites.add({ numbers, source, label });
    if (res.ok) notify('즐겨찾기에 추가됨');
    else if (res.reason === 'duplicate') notify('이미 즐겨찾기에 있습니다');
    else notify('번호가 올바르지 않습니다');
  };

  const handleImage = async () => {
    setBusy('image');
    try {
      const blob = await renderComboImage({
        numbers,
        title: '🎱 로또 추천 번호',
        subtitle: label,
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadBlob(blob, `lotto-${stamp}.png`);
      notify('이미지를 저장했습니다');
    } catch (err) {
      notify(err instanceof Error ? err.message : '이미지 생성 실패');
    } finally {
      setBusy(null);
    }
  };

  const handleShare = async () => {
    setBusy('share');
    try {
      const res = await shareCombo(numbers, { includeImage: true });
      if (res.ok) {
        notify(res.via === 'web-share' ? '공유 완료' : '클립보드에 복사됨');
      } else if (res.reason === 'cancelled') {
        /* 사용자 취소 — 알리지 않음 */
      } else if (res.reason === 'unsupported') {
        notify('이 브라우저는 공유 기능을 지원하지 않습니다');
      } else {
        notify(res.message ?? '공유 실패');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      {showCopy && (
        <Button
          size="small"
          variant="text"
          onClick={handleCopy}
          disabled={busy === 'copy'}
          sx={{ minWidth: 56, fontWeight: 700 }}
        >
          {copied ? '완료' : '복사'}
        </Button>
      )}
      {showFavorite && (
        <Tooltip title={isFav ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'}>
          <IconButton
            size="small"
            onClick={handleFavorite}
            aria-label={isFav ? '즐겨찾기 해제' : '즐겨찾기 추가'}
            sx={{ color: isFav ? '#FBC400' : 'text.secondary' }}
          >
            {isFav ? '★' : '☆'}
          </IconButton>
        </Tooltip>
      )}
      {showImage && (
        <Tooltip title="PNG 이미지로 저장">
          <IconButton
            size="small"
            onClick={handleImage}
            disabled={busy === 'image'}
            aria-label="이미지로 저장"
          >
            ⬇
          </IconButton>
        </Tooltip>
      )}
      {showShare && (
        <Tooltip title="공유하기 (모바일은 시스템 공유, 데스크탑은 클립보드)">
          <IconButton
            size="small"
            onClick={handleShare}
            disabled={busy === 'share'}
            aria-label="공유"
          >
            ↗
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}
