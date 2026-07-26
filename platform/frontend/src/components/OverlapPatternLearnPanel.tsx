/**
 * L10-E. 줄겹침 패턴 역산 학습 — 복기 당첨 일치 겹침 구조를 역산해 이번회차 겹침을 채점.
 * 학습 엔진 규격: 항상 EngineSection 노출(빈 상태 포함) + SubBlock + StatusChip.
 */
import { Alert, Box, Stack, Tooltip, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import { ENGINE_BALL, EngineSection, EngineStatusChip, EngineSubBlock } from './EngineSection';
import type { PhotoAnalysisAccumulated } from '../api/v1Api';
import {
  learnOverlapProfile,
  rankCurrentByProfile,
  type Discriminator,
  type LearnConfidence,
} from '../utils/overlapPatternLearning';

const CONF_COLOR: Record<LearnConfidence, 'error' | 'warning' | 'success' | 'default'> = {
  none: 'error',
  low: 'warning',
  medium: 'success',
};
const CONF_LABEL: Record<LearnConfidence, string> = {
  none: '신뢰도 매우낮음',
  low: '신뢰도 낮음',
  medium: '신뢰도 보통',
};

const DIR_ARROW: Record<Discriminator['dir'], string> = { higher: '▲ 높음', lower: '▼ 낮음', flat: '― 무관' };

export default function OverlapPatternLearnPanel({
  accumulated,
  modeLabel = '학습',
}: {
  accumulated: PhotoAnalysisAccumulated | null;
  /** 복기/이번회차 탭 라벨 — 표시용 */
  modeLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const review = accumulated?.by_intent?.review ?? null;
  const current = accumulated?.by_intent?.current_round ?? null;

  const winningNumbers = review?.draw_template?.winning_numbers ?? null;
  const reviewRound = review?.draw_template?.ticket_round ?? review?.ticket_round ?? null;
  const currentRound = current?.ticket_round ?? null;

  const profile = useMemo(
    () => learnOverlapProfile(review?.accumulated_combo_patterns ?? null, winningNumbers),
    [review?.accumulated_combo_patterns, winningNumbers]
  );

  const ranked = useMemo(
    () => rankCurrentByProfile(current?.accumulated_combo_patterns ?? null, profile),
    [current?.accumulated_combo_patterns, profile]
  );

  const hasSample = Boolean(review && profile.totalCombos > 0 && winningNumbers?.length);
  const topCombo = ranked.slice(0, 6).map((r) => r.number).sort((a, b) => a - b);

  return (
    <EngineSection
      id="learn-l10e"
      tone="success"
      title="L10-E. 줄겹침 패턴 역산 학습"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      chips={
        <>
          <EngineStatusChip variant="outlined" label={modeLabel} />
          <EngineStatusChip
            color={hasSample ? CONF_COLOR[profile.confidence] : 'default'}
            label={hasSample ? CONF_LABEL[profile.confidence] : '표본 없음'}
          />
          {reviewRound != null && (
            <EngineStatusChip variant="outlined" label={`학습 ${reviewRound}회`} />
          )}
          {currentRound != null && (
            <EngineStatusChip variant="outlined" label={`적용 ${currentRound}회`} />
          )}
        </>
      }
      intent={
        <>
          복기 줄겹침(2·3·4) 중 <strong>당첨 완전일치</strong> 구조를 역산 → 이번회차 겹침 조합을 같은 기준으로 채점·정렬합니다.
          ③ 추천 주입은 검증 통과·비평탄일 때만(별도 게이트).
        </>
      }
    >
      {!hasSample ? (
        <Alert severity="info" sx={{ py: 0.5 }}>
          {!review
            ? '복기 슬라이스가 없어 학습할 수 없습니다. 복기 용지를 등록하세요.'
            : !winningNumbers?.length
              ? '복기 당첨번호가 없어 완전일치 표본을 만들 수 없습니다.'
              : profile.totalCombos === 0
                ? '복기 겹침 조합이 없습니다. 자동·반자동 줄이 쌓이면 채워집니다.'
                : '학습 표본이 부족합니다.'}
        </Alert>
      ) : (
        <Stack spacing={1.25}>
          <EngineSubBlock
            tone="success"
            title="A. 학습 표본 (복기)"
            chips={
              <>
                <EngineStatusChip variant="outlined" label={`전체 ${profile.totalCombos}`} />
                <EngineStatusChip color="success" label={`완전일치 ${profile.winningCombos}`} />
                <EngineStatusChip variant="outlined" label={`부분 ${profile.partialCombos}`} />
              </>
            }
          >
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
              {reviewRound ?? '?'}회 겹침 조합에서 당첨 6개와 구조가 맞는 표본만 프로파일로 씁니다.
            </Typography>
          </EngineSubBlock>

          {profile.win && profile.rest && (
            <EngineSubBlock tone="info" title="B. 판별 특성 (당첨일치 vs 나머지)">
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {profile.discriminators.map((d) => (
                  <Tooltip key={d.key} title={`당첨일치 평균 ${d.win} · 나머지 평균 ${d.rest}`} arrow>
                    <Box component="span">
                      <EngineStatusChip
                        variant={d.dir === 'flat' ? 'outlined' : 'filled'}
                        color={d.dir === 'flat' ? 'default' : 'primary'}
                        label={`${d.label} ${DIR_ARROW[d.dir]}`}
                        sx={{ cursor: 'help' }}
                      />
                    </Box>
                  </Tooltip>
                ))}
              </Stack>
            </EngineSubBlock>
          )}

          <EngineSubBlock
            tone="warning"
            title="C. 이번회차 적용 후보"
            chips={
              <EngineStatusChip
                variant="outlined"
                label={ranked.length > 0 ? `${ranked.length}개 번호` : '후보 없음'}
              />
            }
          >
            {ranked.length > 0 ? (
              <>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 0.75 }}>
                  {ranked.map((r) => (
                    <Box key={r.number} sx={{ textAlign: 'center' }}>
                      <LottoBall number={r.number} size={ENGINE_BALL.list} />
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
                      <LottoBall key={`tc-${n}`} number={n} size={ENGINE_BALL.list} />
                    ))}
                    <SharingBadge numbers={topCombo} />
                    <ComboActions numbers={topCombo} source="unknown" label="줄겹침 학습 후보" />
                  </Stack>
                )}
              </>
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                {profile.win
                  ? '이번회차 겹침 조합이 없습니다. 이번회차 자동 용지를 등록하면 채점됩니다.'
                  : '복기에 완전 당첨 겹침 조합이 없어 프로파일을 못 만들었습니다(드묾·정상). 회차가 쌓이면 채점됩니다.'}
              </Typography>
            )}
          </EngineSubBlock>

          <Typography variant="caption" sx={{ display: 'block', fontStyle: 'italic', color: 'text.disabled', fontSize: 9 }}>
            ※ {profile.note}
          </Typography>
        </Stack>
      )}
    </EngineSection>
  );
}
