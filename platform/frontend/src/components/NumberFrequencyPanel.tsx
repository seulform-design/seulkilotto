/**
 * 1~45 번호 빈도 막대 차트.
 *
 * 자동(§2 구입번호 직접입력) / 반자동(§3 반자동 비교) 양쪽에서 재사용.
 * 데이터 소스(=lines)는 호출자가 결정·평탄화하여 number[][] 로 전달.
 * → 자동/반자동 누적은 본 컴포넌트 외부에서 분리 관리됨.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import LottoBall from './LottoBall';

interface NumberFrequencyPanelProps {
  /** 평탄화된 줄들 (각 6개). 호출자가 자동·반자동 누적을 분리 또는 결합. */
  lines: number[][];
  /** 당첨번호 매핑 (있으면 🎯 dim/하이라이트). null → dim 없음. */
  winningSet: Set<number> | null;
  /**
   * 헤더 좌측 텍스트의 데이터 소스 부분.
   * 예: '자동 = 구입번호 직접입력', '반자동 누적'
   */
  sourceLabel: string;
  /** 빈 상태 안내. */
  emptyHint: string;
  /** 본문 캡션의 데이터 소스 표현. 예: '자동 (구입번호 직접입력)', '반자동 누적'. */
  bodyLabel: string;
  /** 기본 펼침 여부 (default: true). */
  defaultOpen?: boolean;
}

export default function NumberFrequencyPanel({
  lines,
  winningSet,
  sourceLabel,
  emptyHint,
  bodyLabel,
  defaultOpen = true,
}: NumberFrequencyPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  const frequency = useMemo(() => {
    if (lines.length === 0) return [];
    const counter: Record<number, number> = {};
    for (let n = 1; n <= 45; n += 1) counter[n] = 0;
    for (const line of lines) {
      for (const n of line) {
        if (Number.isInteger(n) && n >= 1 && n <= 45) {
          counter[n] = (counter[n] ?? 0) + 1;
        }
      }
    }
    return Object.entries(counter)
      .map(([n, count]) => ({ number: Number(n), count }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count || a.number - b.number);
  }, [lines]);

  const totalLines = lines.length;
  const maxCount = frequency[0]?.count ?? 1;

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen((v) => !v)}
      >
        <Typography variant="subtitle2" fontWeight={700}>
          📊 전체 번호 빈도 ({sourceLabel} {totalLines}줄 · 등장 {frequency.length}개)
          {open ? ' ▼' : ' ▶'}
        </Typography>
        <Button size="small" variant="text">
          {open ? '접기' : '펼치기'}
        </Button>
      </Stack>
      {open && (
        <Box sx={{ mt: 1.5 }}>
          {frequency.length === 0 ? (
            <Alert severity="info">{emptyHint}</Alert>
          ) : (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                {bodyLabel} {totalLines}줄에서 각 번호 등장 횟수. 막대 길이 = 최대 대비 비율.
                {winningSet ? ' 🎯 = 당첨번호.' : ''}
              </Typography>
              <Box
                sx={{
                  maxHeight: 360,
                  overflowY: 'auto',
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  p: 0.75,
                }}
              >
                <Stack spacing={0.4}>
                  {frequency.map((item, idx) => {
                    const widthPct = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
                    const isWinning = winningSet?.has(item.number);
                    return (
                      <Stack
                        key={item.number}
                        direction="row"
                        alignItems="center"
                        spacing={0.5}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Typography
                          variant="caption"
                          sx={{ minWidth: 30, color: 'text.secondary', fontWeight: 600 }}
                        >
                          #{idx + 1}
                        </Typography>
                        <LottoBall
                          number={item.number}
                          size={26}
                          dimmed={winningSet ? !isWinning : false}
                        />
                        <Box sx={{ flex: 1, minWidth: 80, position: 'relative' }}>
                          <LinearProgress
                            variant="determinate"
                            value={widthPct}
                            sx={{
                              height: 18,
                              borderRadius: 1,
                              bgcolor: 'action.selected',
                              '& .MuiLinearProgress-bar': {
                                bgcolor: isWinning
                                  ? 'warning.main'
                                  : item.count >= maxCount * 0.7
                                    ? 'success.main'
                                    : 'primary.main',
                              },
                            }}
                          />
                          <Typography
                            variant="caption"
                            sx={{
                              position: 'absolute',
                              top: 0,
                              left: 8,
                              lineHeight: '18px',
                              fontWeight: 700,
                              color: '#fff',
                              textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                            }}
                          >
                            {item.count}회
                          </Typography>
                        </Box>
                        {isWinning && (
                          <Chip
                            size="small"
                            color="warning"
                            label="🎯 당첨"
                            sx={{ height: 18, fontSize: 10 }}
                          />
                        )}
                      </Stack>
                    );
                  })}
                </Stack>
              </Box>
            </>
          )}
        </Box>
      )}
    </Paper>
  );
}
