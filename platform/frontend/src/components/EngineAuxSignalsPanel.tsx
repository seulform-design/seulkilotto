/**
 * ④ 패턴 분석 엔진 — 후속출현 · 구간 gap 패널.
 * 용지 미출현(티켓에 없는 번호)은 학습 엔진에서 제외 — 티켓 기반 추출 한계 표시일 뿐 학습 신호가 아님.
 */
import { Alert, Stack, Typography } from '@mui/material';
import LottoBall from './LottoBall';
import { ENGINE_BALL, EngineSection, EngineStatusChip, EngineTabBanner } from './EngineSection';

type PostSource = {
  available: boolean;
  trigger_round?: number;
  grades?: { S?: number[]; A?: number[]; B?: number[] };
};

type DecadeGapSource = {
  available: boolean;
  pool?: number[];
  pool_size?: number;
  table?: Record<string, { number: number; gap: number }[]>;
  summary?: string;
};

export default function EngineAuxSignalsPanel({
  intentLabel,
  roundNo,
  postOccurrence,
  decadeGap,
}: {
  intentLabel: string;
  roundNo: number | null | undefined;
  postOccurrence?: PostSource | null;
  decadeGap?: DecadeGapSource | null;
}) {
  const postS = postOccurrence?.grades?.S ?? [];
  const postA = postOccurrence?.grades?.A ?? [];
  const postB = postOccurrence?.grades?.B ?? [];
  const gapPool = decadeGap?.pool ?? [];

  return (
    <Stack spacing={1.5}>
      <EngineTabBanner
        title="후속·gap — 보조 신호"
        chips={
          <>
            <EngineStatusChip
              color={postOccurrence?.available ? 'success' : 'default'}
              label={postOccurrence?.available ? '후속 ON' : '후속 OFF'}
            />
            <EngineStatusChip
              color={decadeGap?.available ? 'info' : 'default'}
              label={decadeGap?.available ? `gap ${decadeGap.pool_size ?? gapPool.length}` : 'gap OFF'}
            />
            <EngineStatusChip variant="outlined" label={`${intentLabel} ${roundNo ?? '?'}회`} />
          </>
        }
        intent={
          <>
            후속출현·구간 gap만 봅니다(용지 미출현 제외). 더 깊은 표·전략은 앱 상단{' '}
            <strong>후속 출현 통계</strong> 탭. 역산·학습 주입은 <strong>학습 엔진</strong> 탭.
          </>
        }
      />

      <EngineSection
        title="📈 후속출현 신호"
        tone="secondary"
        chips={
          <>
            <EngineStatusChip
              color={postOccurrence?.available ? 'success' : 'default'}
              label={postOccurrence?.available ? '신호 ON' : '신호 없음'}
            />
            {postOccurrence?.trigger_round != null && (
              <EngineStatusChip variant="outlined" label={`트리거 ${postOccurrence.trigger_round}회`} />
            )}
          </>
        }
        intent={
          <>
            직전 조합이 과거에 등장한 뒤 <strong>다음 회차</strong>에 자주 나온 번호 등급(S/A/B).
            통합 예측 신호의 후속 축과 동일 소스입니다.
          </>
        }
      >
        {!postOccurrence?.available ? (
          <Alert severity="warning" sx={{ py: 0.5 }}>
            후속출현 신호가 아직 없습니다. 재분석 또는 후속 출현 통계 탭에서 분석을 실행하세요.
          </Alert>
        ) : (
          <Stack spacing={0.75}>
            {(
              [
                ['S', postS, 'error' as const],
                ['A', postA, 'warning' as const],
                ['B', postB, 'info' as const],
              ] as const
            ).map(([grade, nums, color]) => (
              <Stack key={grade} direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                <EngineStatusChip color={color} label={`후속 ${grade} ${nums.length}`} sx={{ minWidth: 72 }} />
                {nums.length === 0 ? (
                  <Typography variant="caption" color="text.disabled">
                    —
                  </Typography>
                ) : (
                  nums.slice(0, 18).map((n) => <LottoBall key={`post-${grade}-${n}`} number={n} size={ENGINE_BALL.list} />)
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </EngineSection>

      <EngineSection
        title="❄ 구간 미출현 (gap)"
        tone="info"
        chips={
          <EngineStatusChip
            color={decadeGap?.available ? 'info' : 'default'}
            label={decadeGap?.available ? `풀 ${decadeGap.pool_size ?? gapPool.length}수` : '신호 없음'}
          />
        }
        intent={decadeGap?.summary ?? '구간별 미출현(gap)이 긴 번호 풀 — 통합 신호 decade_gap 축과 동일.'}
      >
        {gapPool.length > 0 ? (
          <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
            {gapPool.slice(0, 24).map((n) => (
              <LottoBall key={`gap-${n}`} number={n} size={ENGINE_BALL.list} />
            ))}
          </Stack>
        ) : (
          <Alert severity="info" sx={{ py: 0.5 }}>
            구간 미출현 풀이 비어 있습니다.
          </Alert>
        )}
        {decadeGap?.table && (
          <Stack spacing={0.4} sx={{ mt: 1 }}>
            {Object.entries(decadeGap.table).map(([band, rows]) => (
              <Stack key={band} direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                <Typography variant="caption" fontWeight={700} sx={{ minWidth: 52, fontSize: 10 }}>
                  {band}
                </Typography>
                {(rows ?? []).slice(0, 6).map((r) => (
                  <EngineStatusChip
                    key={`${band}-${r.number}`}
                    variant="outlined"
                    label={`${r.number}·${r.gap}회`}
                    sx={{ height: 18, fontSize: 9, fontWeight: 600 }}
                  />
                ))}
              </Stack>
            ))}
          </Stack>
        )}
      </EngineSection>
    </Stack>
  );
}
