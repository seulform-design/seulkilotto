/**
 * V4-B. 줄겹침 (복기 프로파일) — 복기 당첨 일치 겹침 구조를 역산해 이번회차 겹침을 채점.
 * 서버 다회차 겹침API가 평탄/부재일 때 클라이언트 프로파일이 약한 fallback 주입을 담당할 수 있다.
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
  sheetIntent = 'current_round',
  modeLabel = '학습',
  injectHint,
}: {
  accumulated: PhotoAnalysisAccumulated | null;
  sheetIntent?: 'review' | 'current_round';
  /** 복기/이번회차 탭 라벨 — 표시용 */
  modeLabel?: string;
  /** 상위(SemiAuto)에서 계산한 주입 상태 한 줄 */
  injectHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const review = accumulated?.by_intent?.review ?? null;
  const current = accumulated?.by_intent?.current_round ?? null;
  const applySlice = sheetIntent === 'review' ? review : current;

  const winningNumbers = review?.draw_template?.winning_numbers ?? null;
  const reviewRound = review?.draw_template?.ticket_round ?? review?.ticket_round ?? null;
  const applyRound =
    applySlice?.draw_template?.ticket_round ?? applySlice?.ticket_round ?? null;

  const profile = useMemo(
    () => learnOverlapProfile(review?.accumulated_combo_patterns ?? null, winningNumbers),
    [review?.accumulated_combo_patterns, winningNumbers]
  );

  const ranked = useMemo(
    () => rankCurrentByProfile(applySlice?.accumulated_combo_patterns ?? null, profile),
    [applySlice?.accumulated_combo_patterns, profile]
  );

  const hasSample = Boolean(review && profile.totalCombos > 0 && winningNumbers?.length);
  const topCombo = ranked.slice(0, 6).map((r) => r.number).sort((a, b) => a - b);
  const canSoftInject = profile.confidence !== 'none' && ranked.length > 0;

  return (
    <EngineSection
      id="learn-v4b"
      tone="success"
      title="V4-B. 줄겹침 (복기 프로파일)"
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
          {profile.usedPartialFallback && (
            <EngineStatusChip color="warning" label="부분일치 보강" />
          )}
          <EngineStatusChip
            color={canSoftInject ? 'info' : 'default'}
            label={canSoftInject ? '서버 평탄 시 fallback' : '주입 대기'}
          />
          {reviewRound != null && (
            <EngineStatusChip variant="outlined" label={`학습 ${reviewRound}회`} />
          )}
          {applyRound != null && (
            <EngineStatusChip variant="outlined" label={`적용 ${applyRound}회`} />
          )}
        </>
      }
      intent={
        <>
          복기 줄겹침(2·3·4)의 <strong>완전·부분 당첨일치</strong> 구조를 학습합니다.
          적용은 탭별 — 복기=<strong>소급</strong>, 이번회차=<strong>예상</strong>.
          V4-A가 살아 있으면 우선, <strong>평탄/부재일 때만</strong> fallback.
          {injectHint ? <> · {injectHint}</> : null}
        </>
      }
    >
      {!hasSample ? (
        <Alert severity="info" sx={{ py: 0.5 }}>
          {!review
            ? '복기 슬라이스가 없어 학습할 수 없습니다. 복기 용지를 등록하세요.'
            : !winningNumbers?.length
              ? '복기 당첨번호가 없어 일치 표본을 만들 수 없습니다.'
              : profile.totalCombos === 0
                ? '복기 겹침 조합이 없습니다. 자동·반자동 줄이 2줄 이상 쌓이면 채워집니다.'
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
                <EngineStatusChip variant="outlined" label={`양성 ${profile.positiveCombos}`} />
              </>
            }
          >
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
              {reviewRound ?? '?'}회 겹침 조합. 완전일치가 드물면(정상) 부분일치(절반+)로 프로파일을 보강합니다.
            </Typography>
          </EngineSubBlock>

          {profile.win && profile.rest && (
            <EngineSubBlock tone="info" title="B. 판별 특성 (양성 vs 나머지)">
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {profile.discriminators.map((d) => (
                  <Tooltip key={d.key} title={`양성 평균 ${d.win} · 나머지 평균 ${d.rest}`} arrow>
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
              {profile.discriminators.every((d) => d.dir === 'flat') && (
                <Alert severity="info" sx={{ mt: 0.75, py: 0.25 }}>
                  판별 특성이 모두 평탄합니다 — 채점은 lift·줄수 약한 프록시로 후보만 보여 줍니다.
                </Alert>
              )}
            </EngineSubBlock>
          )}

          <EngineSubBlock
            tone="warning"
            title={sheetIntent === 'review' ? 'C. 복기 소급 적용' : 'C. 이번회차 예상 후보'}
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
                  ? sheetIntent === 'review'
                    ? '복기 겹침 조합이 없습니다. 복기 자동 용지(2줄+)를 등록하면 소급 채점됩니다.'
                    : '이번회차 겹침 조합이 없습니다. 이번회차 자동 용지(2줄+)를 등록하면 채점됩니다.'
                  : '양성 표본이 없어 프로파일을 못 만들었습니다. 회차·줄이 쌓이면 채점됩니다.'}
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
