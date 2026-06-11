/**
 * 번호별 출현 빈도 바 차트 (1~45 전체).
 * recharts BarChart 사용.
 */
import { Box, Typography, useTheme } from '@mui/material';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { FrequencyItem } from '../api/v1Api';

interface Props {
  items: FrequencyItem[];
  totalRounds: number;
  /** 강조 표시할 번호 집합 (예: 최신 당첨번호) */
  highlight?: Set<number>;
}

function getBallColor(number: number): string {
  if (number <= 10) return '#FBC400';   // 노랑
  if (number <= 20) return '#69C8F2';   // 파랑
  if (number <= 30) return '#FF7272';   // 빨강
  if (number <= 40) return '#AAAAAA';   // 회색
  return '#B0D840';                     // 녹색
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: { payload: FrequencyItem }[];
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <Box
      sx={{
        bgcolor: '#262A30',
        border: '1px solid #33383F',
        borderRadius: 1,
        p: 1.5,
        minWidth: 100,
      }}
    >
      <Typography variant="body2" fontWeight={700}>
        {d.number}번
      </Typography>
      <Typography variant="caption" display="block" color="text.secondary">
        출현 {d.count}회
      </Typography>
      <Typography variant="caption" display="block" color="text.secondary">
        비율 {(d.ratio * 100).toFixed(1)}%
      </Typography>
    </Box>
  );
}

export default function FrequencyBarChart({ items, totalRounds, highlight }: Props) {
  // 정렬: 번호 순서 (1~45)
  const sorted = [...items].sort((a, b) => a.number - b.number);
  // 기댓값 선 (균등 분포 기준)
  const expected = totalRounds > 0 ? (totalRounds * 6) / 45 : null;

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        점선 = 균등 기댓값 ({expected ? expected.toFixed(1) : '—'}회)
        {highlight && highlight.size > 0 && ' · 밝은 색 = 최신 당첨번호'}
      </Typography>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={sorted} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <XAxis
            dataKey="number"
            tick={{ fontSize: 10, fill: '#888' }}
            interval={4}
          />
          <YAxis tick={{ fontSize: 10, fill: '#888' }} />
          <Tooltip content={<CustomTooltip />} />
          {expected && (
            <ReferenceLine
              y={expected}
              stroke="#FBC40080"
              strokeDasharray="4 3"
            />
          )}
          <Bar dataKey="count" maxBarSize={14} radius={[2, 2, 0, 0]}>
            {sorted.map((entry) => {
              const isHighlight = highlight?.has(entry.number);
              const base = getBallColor(entry.number);
              return (
                <Cell
                  key={`cell-${entry.number}`}
                  fill={isHighlight ? base : `${base}99`}
                  stroke={isHighlight ? base : 'none'}
                  strokeWidth={isHighlight ? 1 : 0}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 1 }}>
        {[
          { color: '#FBC400', label: '1~10' },
          { color: '#69C8F2', label: '11~20' },
          { color: '#FF7272', label: '21~30' },
          { color: '#AAAAAA', label: '31~40' },
          { color: '#B0D840', label: '41~45' },
        ].map(({ color, label }) => (
          <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color }} />
            <Typography variant="caption" color="text.secondary">{label}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
