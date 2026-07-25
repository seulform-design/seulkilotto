/**
 * ④ 패턴 분석 엔진 — 후속출현 · 미출현 통합 패널.
 * 기능 누락 없이 엔진 한곳에 모은다(전체 후속 탭은 심화 분석용으로 유지).
 */
import { Alert, Box, Stack, Typography } from '@mui/material';
import LottoBall from './LottoBall';
import { EngineSection, EngineStatusChip, EngineTabBanner } from './EngineSection';

export type MissingBand = {
  label: string;
  missing: { number: number; winning: boolean }[];
};

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
  compareWinning,
  missingBands,
  missingCount,
  missingWinDist,
  postOccurrence,
  decadeGap,
}: {
  intentLabel: string;
  roundNo: number | null | undefined;
  compareWinning: boolean;
  missingBands: MissingBand[] | null;
  missingCount: number;
  missingWinDist: number | null;
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
        title="후속·미출 — 빈틈 진단"
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
            <EngineStatusChip
              color={missingCount > 0 ? 'warning' : 'success'}
              label={missingCount > 0 ? `용지미출 ${missingCount}` : '용지미출 0'}
            />
            <EngineStatusChip variant="outlined" label={`${intentLabel} ${roundNo ?? '?'}회`} />
          </>
        }
        intent={
          <>
            후속출현·구간 gap·용지 미출현을 한 화면에서 봅니다. 더 깊은 표·전략은 앱 상단{' '}
            <strong>후속 출현 통계</strong> 탭. 1등 확률(1/8,145,060)은 불변.
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
                  nums.slice(0, 18).map((n) => <LottoBall key={`post-${grade}-${n}`} number={n} size={22} />)
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
              <LottoBall key={`gap-${n}`} number={n} size={22} />
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

      <EngineSection
        title="🕳 용지 미출현 번호"
        tone="warning"
        chips={
          <>
            <EngineStatusChip variant="outlined" label={`${missingCount}개`} />
            {compareWinning && missingWinDist != null && (
              <EngineStatusChip
                color={missingWinDist > 0 ? 'warning' : 'default'}
                label={`당첨 ${missingWinDist}개 (티켓으로 못 잡음)`}
              />
            )}
          </>
        }
        intent={
          <>
            자동·반자동 어느 줄에도 없는 번호 — 티켓 빈도/1:1로는 추출 불가 영역입니다.
            {compareWinning
              ? ` ${roundNo ?? '?'}회 당첨이 여기 있으면 그 회차는 용지 분석만으로 못 잡습니다.`
              : ' 이번회차(미추첨) — 당첨 대조 없음.'}
          </>
        }
      >
        {!missingBands || missingCount === 0 ? (
          <Alert severity="success" sx={{ py: 0.5 }}>
            용지 미출현이 없습니다(1~45가 티켓에 모두 등장).
          </Alert>
        ) : (
          <Stack spacing={0.5}>
            {missingBands.map((b) => (
              <Stack key={b.label} direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
                <Typography variant="caption" fontWeight={700} sx={{ minWidth: 44, fontSize: 10 }}>
                  {b.label}
                </Typography>
                {b.missing.length === 0 ? (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>
                    —
                  </Typography>
                ) : (
                  b.missing.map((m) => (
                    <Box key={`miss-${m.number}`} sx={{ textAlign: 'center' }}>
                      <LottoBall
                        number={m.number}
                        size={22}
                        dimmed={compareWinning ? !m.winning : true}
                      />
                    </Box>
                  ))
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </EngineSection>
    </Stack>
  );
}
