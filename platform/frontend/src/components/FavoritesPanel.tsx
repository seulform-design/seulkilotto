import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import { useFavorites, type FavoriteSource } from '../hooks/useFavorites';

const SOURCE_LABELS: Record<FavoriteSource, string> = {
  generator: '가중치',
  smart: '스마트',
  epo: 'EPO',
  classic: '클래식',
  recommend: '추첨기',
  fortune: '할매',
  manual: '수동',
  unknown: '기타',
};

function formatDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export default function FavoritesPanel() {
  const favorites = useFavorites();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const handleStartEdit = (id: string, currentLabel: string) => {
    setEditingId(id);
    setDraftLabel(currentLabel);
  };

  const handleSaveEdit = (id: string) => {
    favorites.update(id, { label: draftLabel.trim() || '조합' });
    setEditingId(null);
    setDraftLabel('');
  };

  const handleClearAll = () => {
    if (favorites.list.length === 0) return;
    if (window.confirm(`즐겨찾기 ${favorites.list.length}개를 모두 삭제할까요?`)) {
      favorites.clear();
      setNotice('전체 삭제 완료');
      setTimeout(() => setNotice(null), 2000);
    }
  };

  // 최신순 정렬
  const sorted = [...favorites.list].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <Paper sx={{ p: 2 }}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ mb: 1.5 }}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            ⭐ 즐겨찾기
          </Typography>
          <Typography variant="caption" color="text.secondary">
            로컬 브라우저에 저장 · 총 {favorites.list.length}개
          </Typography>
        </Box>
        {favorites.list.length > 0 && (
          <Button size="small" color="error" variant="outlined" onClick={handleClearAll}>
            전체 삭제
          </Button>
        )}
      </Stack>

      {notice && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {notice}
        </Alert>
      )}
      {favorites.persistError && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          저장 공간(localStorage)이 부족해 즐겨찾기가 영구 저장되지 않았습니다.
          오래된 항목을 삭제한 뒤 다시 시도하세요. (새로고침 시 미저장분은 사라질 수 있습니다.)
        </Alert>
      )}

      {sorted.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
          아직 즐겨찾기가 없습니다. 추천 조합 옆 ☆ 버튼으로 추가하세요.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {sorted.map((fav) => {
            const isEditing = editingId === fav.id;
            return (
              <Box
                key={fav.id}
                sx={{
                  p: 1.5,
                  borderRadius: 1.5,
                  bgcolor: 'action.hover',
                }}
              >
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  alignItems={{ xs: 'flex-start', sm: 'center' }}
                  spacing={1}
                >
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                    {fav.numbers.map((n) => (
                      <LottoBall key={n} number={n} size={32} />
                    ))}
                  </Stack>
                  <ComboActions
                    numbers={fav.numbers}
                    source={fav.source}
                    label={fav.label}
                    showFavorite={false}
                    onNotice={(m) => {
                      setNotice(m);
                      setTimeout(() => setNotice(null), 2000);
                    }}
                  />
                  <IconButton
                    size="small"
                    onClick={() => favorites.remove(fav.id)}
                    aria-label="삭제"
                  >
                    ×
                  </IconButton>
                </Stack>

                <Stack
                  direction="row"
                  spacing={0.75}
                  alignItems="center"
                  sx={{ mt: 1, flexWrap: 'wrap' }}
                  useFlexGap
                >
                  {isEditing ? (
                    <>
                      <TextField
                        size="small"
                        value={draftLabel}
                        onChange={(e) => setDraftLabel(e.target.value)}
                        autoFocus
                        sx={{ flex: 1, minWidth: 140 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit(fav.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <Button size="small" onClick={() => handleSaveEdit(fav.id)}>
                        저장
                      </Button>
                      <Button size="small" onClick={() => setEditingId(null)}>
                        취소
                      </Button>
                    </>
                  ) : (
                    <>
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => handleStartEdit(fav.id, fav.label)}
                      >
                        {fav.label}
                      </Typography>
                      <Chip
                        label={SOURCE_LABELS[fav.source] ?? '기타'}
                        size="small"
                        variant="outlined"
                      />
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(fav.createdAt)}
                      </Typography>
                    </>
                  )}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 2, display: 'block', fontStyle: 'italic' }}
      >
        ※ 즐겨찾기는 이 브라우저에만 저장됩니다. 브라우저 캐시 삭제 시 함께 사라집니다.
      </Typography>
    </Paper>
  );
}
