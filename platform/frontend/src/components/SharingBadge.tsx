import { Box, Chip, Tooltip, Typography } from '@mui/material';
import { assessJackpotSharing, sharingGradeLabel, type SharingGrade } from '../utils/jackpotSharing';

const GRADE_COLOR: Record<SharingGrade, string> = {
  excellent: '#2e7d32',
  good: '#558b2f',
  fair: '#ef6c00',
  poor: '#c62828',
};

/**
 * 잭팟 분산(공동당첨 회피) 배지 — 조합의 '남들과 겹칠 위험'을 EV 관점으로 표시.
 * ⚠️ 당첨 확률은 바꾸지 않는다(불변). 당첨 시 공동분배 회피로 '실수령 기대'만 개선.
 */
export default function SharingBadge({ numbers }: { numbers: number[] }) {
  const a = assessJackpotSharing(numbers);
  // 유효하지 않은 조합(6개 아님)은 배지 숨김.
  if (a.factors.length === 0 && a.risk === 50) return null;
  const color = GRADE_COLOR[a.grade];
  return (
    <Tooltip
      arrow
      title={
        <Box sx={{ p: 0.5, maxWidth: 260 }}>
          <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mb: 0.5 }}>
            분산(EV) {a.evScore}/100 · {sharingGradeLabel(a.grade)}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
            {a.summary}
          </Typography>
          {a.factors.map((f) => (
            <Typography key={f.key} variant="caption" sx={{ display: 'block', lineHeight: 1.35 }}>
              {f.delta > 0 ? '▲' : '▼'} {f.label} ({f.delta > 0 ? '+' : ''}
              {f.delta}) — {f.note}
            </Typography>
          ))}
          <Typography
            variant="caption"
            sx={{ display: 'block', mt: 0.5, fontStyle: 'italic', opacity: 0.85 }}
          >
            ※ 당첨 확률(1/8,145,060)은 불변. 당첨 시 공동분배 회피(실수령 기대)만 개선합니다.
          </Typography>
        </Box>
      }
    >
      <Chip
        size="small"
        label={`분산 ${a.evScore} · ${sharingGradeLabel(a.grade)}`}
        sx={{ bgcolor: color, color: '#fff', fontWeight: 700, height: 20, fontSize: 11, cursor: 'help' }}
      />
    </Tooltip>
  );
}
