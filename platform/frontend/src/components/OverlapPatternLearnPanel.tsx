import { Box, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { useMemo } from 'react';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import type { PhotoAnalysisAccumulated } from '../api/v1Api';
import {
  learnOverlapProfile,
  rankCurrentByProfile,
  type Discriminator,
  type LearnConfidence,
} from '../utils/overlapPatternLearning';

const CONF_COLOR: Record<LearnConfidence, string> = {
  none: '#c62828',
  low: '#ef6c00',
  medium: '#2e7d32',
};
const CONF_LABEL: Record<LearnConfidence, string> = {
  none: '신뢰도 매우낮음',
  low: '신뢰도 낮음',
  medium: '신뢰도 보통',
};

const DIR_ARROW: Record<Discriminator['dir'], string> = { higher: '▲ 높음', lower: '▼ 낮음', flat: '― 무관' };

/**
 * 🔎 줄겹침 패턴 역산 학습 — 복기 겹침 조합 중 당첨과 일치한 것의 구조를 역산해
 * 이번회차 겹침 조합을 채점·정렬. 확률은 불변(서술·정렬 도구).
 */
export default function OverlapPatternLearnPanel({
  accumulated,
}: {
  accumulated: PhotoAnalysisAccumulated | null;
}) {
  const review = accumulated?.by_intent?.review ?? null;
  const current = accumulated?.by_intent?.current_round ?? null;

  const winningNumbers = review?.draw_template?.winning_numbers ?? null;
  const reviewRound = review?.draw_template?.ticket_round ?? review?.ticket_round ?? null;

  const profile = useMemo(
    () => learnOverlapProfile(review?.accumulated_combo_patterns ?? null, winningNumbers),
    [review?.accumulated_combo_patterns, winningNumbers]
  );

  const ranked = useMemo(
    () => rankCurrentByProfile(current?.accumulated_combo_patterns ?? null, profile),
    [current?.accumulated_combo_patterns, profile]
  );

  // 학습 근거가 전혀 없으면(복기 겹침·당첨 없음) 패널 숨김.
  if (!review || profile.totalCombos === 0 || !winningNumbers?.length) return null;

  const topCombo = ranked.slice(0, 6).map((r) => r.number).sort((a, b) => a - b);

  return (
    <Paper sx={{ p: 2, mb: 2, border: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle1" fontWeight={800}>
          🔎 줄겹침 패턴 역산 학습
        </Typography>
        <Chip
          size="small"
          label={CONF_LABEL[profile.confidence]}
          sx={{ bgcolor: CONF_COLOR[profile.confidence], color: '#fff', fontWeight: 700, height: 20 }}
        />
        {reviewRound && (
          <Chip size="small" variant="outlined" label={`복기 ${reviewRound}회 기준`} sx={{ height: 20 }} />
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        복기 '다른 줄에도 겹침(2·3·4번호)' 조합 중 <strong>실제 당첨번호와 일치한 조합</strong>이 어떤 구조
        (겹친 줄 수·lift·z)를 가졌는지 역산해, 이번회차 겹침 조합을 같은 기준으로 채점합니다.
      </Typography>

      {/* 학습 표본 */}
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
        <Chip size="small" variant="outlined" label={`전체 겹침 ${profile.totalCombos}건`} />
        <Chip size="small" color="success" label={`당첨 완전일치 ${profile.winningCombos}건`} sx={{ fontWeight: 700 }} />
        <Chip size="small" variant="outlined" label={`부분일치 ${profile.partialCombos}건`} />
      </Stack>

      {/* 판별 특성 — 당첨 일치 조합 vs 나머지 */}
      {profile.win && profile.rest && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>
            당첨 일치 조합의 구조적 특징 (당첨일치 vs 나머지 평균)
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {profile.discriminators.map((d) => (
              <Tooltip key={d.key} title={`당첨일치 평균 ${d.win} · 나머지 평균 ${d.rest}`} arrow>
                <Chip
                  size="small"
                  variant={d.dir === 'flat' ? 'outlined' : 'filled'}
                  color={d.dir === 'flat' ? 'default' : 'primary'}
                  label={`${d.label} ${DIR_ARROW[d.dir]}`}
                  sx={{ fontSize: 11, cursor: 'help' }}
                />
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}

      {/* 이번회차 학습 후보 */}
      {ranked.length > 0 ? (
        <Box sx={{ mt: 1, p: 1.25, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>
            🎯 이번회차 겹침 조합 학습 후보 (프로파일 부합순 상위)
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 0.75 }}>
            {ranked.map((r) => (
              <Box key={r.number} sx={{ textAlign: 'center' }}>
                <LottoBall number={r.number} size={30} />
                <Typography sx={{ fontSize: 9, color: 'text.disabled', lineHeight: 1 }}>
                  {r.score} · {r.support}조합
                </Typography>
              </Box>
            ))}
          </Stack>
          {topCombo.length === 6 && (
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>
                상위 6:
              </Typography>
              {topCombo.map((n) => (
                <LottoBall key={`tc-${n}`} number={n} size={24} />
              ))}
              <SharingBadge numbers={topCombo} />
              <ComboActions numbers={topCombo} source="unknown" label="줄겹침 학습 후보" />
            </Stack>
          )}
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {profile.win
            ? '이번회차 겹침 조합이 아직 없습니다. 이번회차 자동 용지를 등록하면 학습 프로파일로 후보를 채점합니다.'
            : '복기 회차에 「완전 당첨 겹침 조합」이 없어 학습 프로파일을 만들지 못했습니다(그런 조합은 드묾 — 정상, 이번회차 겹침 조합이 있어도 채점 불가). 회차가 쌓이면 채점됩니다.'}
        </Typography>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1.25, fontStyle: 'italic', color: 'text.disabled' }}>
        ⚠️ {profile.note} 1등 확률(1/8,145,060)은 어떤 패턴으로도 변하지 않습니다 — 본 학습은 분석 일관성 도구입니다.
      </Typography>
    </Paper>
  );
}
