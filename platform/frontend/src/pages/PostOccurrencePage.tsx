import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import PatternAnalysisPanel from '../components/post/PatternAnalysisPanel';
import { v1Api } from '../api/v1Api';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="h6" fontWeight={800} sx={{ mt: 2, mb: 1 }}>
      {children}
    </Typography>
  );
}

function NumTable({
  rows,
  cols,
}: {
  rows: Record<string, unknown>[];
  cols: { key: string; label: string }[];
}) {
  if (!rows.length) return <Typography color="text.secondary">데이터 없음</Typography>;
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          {cols.map((c) => (
            <TableCell key={c.key}>{c.label}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            {cols.map((c) => (
              <TableCell key={c.key}>{String(row[c.key] ?? '')}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const STRATEGY_LABELS: Record<string, string> = {
  stable: '안정형',
  balanced: '균형형',
  aggressive: '공격형',
  high_payout: '고배당형',
};

export default function PostOccurrencePage() {
  const [params, setParams] = useState<{
    roundNo?: number;
    numbers?: number[];
    bonus?: number;
  } | null>(null);

  const latest = useQuery({
    queryKey: ['latest-draw'],
    queryFn: () => v1Api.getLatestDraw(),
  });

  const [runId, setRunId] = useState(0);

  const analysis = useQuery({
    queryKey: ['post-occurrence', params, runId],
    queryFn: () =>
      v1Api.getPostOccurrenceAnalysis(
        params ?? {
          roundNo: latest.data?.round,
          numbers: latest.data?.numbers,
          bonus: latest.data?.bonus,
        }
      ),
    enabled: !!latest.data && runId > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const d = analysis.data;
  const meta = d?.meta;
  const loading = analysis.isLoading || latest.isLoading;
  const hasAnalysis =
    d?.analysis_status !== 'no_eligible_data' &&
    (d?.step3_next_draw_collection?.next_events_collected ?? 0) > 0;
  const recTotal = d?.recommendation_count ?? 0;
  const latestDraw = latest.data;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        후속출현 통계 분석
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        직전 회차 번호 조합이 과거에 등장했을 때, 그 다음 회차에서 실제로 가장 많이 출현한 번호를
        데이터 기반으로 집계합니다. 임의 생성 없이 전 회차 통계만 사용합니다.
        아래 점수·등급·적중률은 <strong>과거 출현 빈도</strong>이며 다음 회차 당첨 확률
        (1/8,145,060)을 바꾸지 않습니다.
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip
          label="최신 회차"
          onClick={() => setParams(null)}
          color={params === null ? 'primary' : 'default'}
          variant={params === null ? 'filled' : 'outlined'}
        />
        {latestDraw && (
          <Chip
            label={`${latestDraw.round}회 (${latestDraw.numbers.join('·')} +${latestDraw.bonus})`}
            onClick={() =>
              setParams({
                roundNo: latestDraw.round,
                numbers: latestDraw.numbers,
                bonus: latestDraw.bonus,
              })
            }
            color={params?.roundNo === latestDraw.round ? 'primary' : 'default'}
            variant={params?.roundNo === latestDraw.round ? 'filled' : 'outlined'}
          />
        )}
        <Chip
          label={analysis.isFetching ? '분석 중… (약 20초)' : '분석 실행'}
          onClick={() => setRunId((id) => id + 1)}
          color="success"
          disabled={!latest.data || analysis.isFetching}
          sx={{ fontWeight: 800 }}
        />
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        {d?.disclaimer ??
          '로또는 무작위 추첨입니다. 분석 결과는 통계 모델이며 당첨을 보장하지 않습니다.'}
      </Alert>

      {loading && (
        <Stack alignItems="center" py={4}>
          <CircularProgress />
          <Typography sx={{ mt: 1 }}>전체 회차 데이터 분석 중…</Typography>
        </Stack>
      )}

      {analysis.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {analysis.error instanceof Error ? analysis.error.message : '분석 실패'}
          {analysis.error instanceof Error &&
            analysis.error.message.includes('404') && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                서버가 예전 버전일 수 있습니다. 터미널에서{' '}
                <code>cd deploy && node start-prod.mjs</code> 로 재시작 후 다시 시도하세요.
              </Typography>
            )}
        </Alert>
      )}

      {runId === 0 && !loading && (
        <Alert severity="info" sx={{ mb: 2 }}>
          회차를 선택한 뒤 <strong>분석 실행</strong> 버튼을 눌러 주세요. (전체 회차 통계 계산, 약 20초)
        </Alert>
      )}

      {analysis.isFetching && runId > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          분석을 다시 계산 중입니다… (약 20초)
        </Alert>
      )}

      {d && meta && (
        <>
          <Paper sx={{ p: 2, mb: 2, opacity: analysis.isFetching ? 0.6 : 1 }}>
            <Typography variant="subtitle2" color="text.secondary">
              분석 기준 · {meta.data_range} ({meta.total_rounds}회차)
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
              <Chip label={`${meta.trigger_round}회`} color="primary" size="small" />
              {meta.trigger_numbers.map((n) => (
                <LottoBall key={n} number={n} size={32} />
              ))}
              <Typography variant="caption">+ 보너스 {meta.trigger_bonus}</Typography>
            </Stack>
            <Alert severity="info" sx={{ mt: 1 }}>
              {d.step1_combinations?.note ??
                '2개 이상 조합 + 발견 2회 이상만 후속출현 분석에 반영합니다. (1개 단일번호는 제외)'}
            </Alert>
            {d.warning && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {d.warning}
              </Alert>
            )}
          </Paper>

          <Grid container spacing={2}>
            <Grid item xs={6} md={3}>
              <Paper sx={{ p: 2 }}>
                <Typography variant="caption">전체 조합 / 분석 반영</Typography>
                <Typography variant="h6">
                  {d.step1_combinations?.total_combo_count} /{' '}
                  {d.step1_combinations?.analysis_combo_count ?? '-'}
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={6} md={3}>
              <Paper sx={{ p: 2 }}>
                <Typography variant="caption">발견 회차 (2개↑조합)</Typography>
                <Typography variant="h6">{d.step2_discovery?.total_discovery_events}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={6} md={3}>
              <Paper sx={{ p: 2 }}>
                <Typography variant="caption">다음회차 수집</Typography>
                <Typography variant="h6">{d.step3_next_draw_collection?.next_events_collected}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={6} md={3}>
              <Paper sx={{ p: 2 }}>
                <Typography variant="caption">최적 λ</Typography>
                <Typography variant="h6">{d.recency_analysis?.optimized_lambda}</Typography>
              </Paper>
            </Grid>
          </Grid>

          <SectionTitle>[중복패턴 분석결과] TOP (2개 이상 조합)</SectionTitle>
          <NumTable
            rows={(d.duplicate_pattern_analysis ?? [])
              .filter((r) => r.combo.length >= 2)
              .slice(0, 15)
              .map((r) => ({
                combo: r.combo.join(','),
                size: r.combo.length,
                discovery_count: r.discovery_count,
                next_collection_count: r.next_collection_count,
                trusted: r.trusted ? 'Y' : 'N',
              }))}
            cols={[
              { key: 'combo', label: '조합' },
              { key: 'size', label: '개수' },
              { key: 'discovery_count', label: '발견횟수' },
              { key: 'next_collection_count', label: '다음회차수집' },
              { key: 'trusted', label: '신뢰(≥10)' },
            ]}
          />

          {hasAnalysis && (
            <>
          <SectionTitle>[TOP20 번호]</SectionTitle>
          <NumTable
            rows={(d.top20_numbers ?? []).map((r) => ({
              number: r.number,
              count: r.count,
              rate: (r.rate * 100).toFixed(2) + '%',
              score: r.score,
            }))}
            cols={[
              { key: 'number', label: '번호' },
              { key: 'count', label: '횟수' },
              { key: 'rate', label: '출현율' },
              { key: 'score', label: '점수' },
            ]}
          />

          <SectionTitle>[백테스트 결과]</SectionTitle>
          <Paper sx={{ p: 2 }}>
            <Typography variant="body2">
              검증 회차: {d.backtest?.window_rounds} · 방식: Rolling Validation (최근 300회)
            </Typography>
            <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
              <Chip label={`TOP6 적중률 ${((d.backtest?.top6_hit_rate ?? 0) * 100).toFixed(1)}%`} />
              <Chip label={`TOP10 적중률 ${((d.backtest?.top10_hit_rate ?? 0) * 100).toFixed(1)}%`} />
              <Chip label={`TOP15 적중률 ${((d.backtest?.top15_hit_rate ?? 0) * 100).toFixed(1)}%`} />
              <Chip label={`평균 적중수 ${d.backtest?.avg_hit_count}`} />
            </Stack>
          </Paper>

          <SectionTitle>[최종 번호 랭킹] 1~45위</SectionTitle>
          <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
            <NumTable
              rows={(d.final_ranking ?? []).map((r) => ({
                rank: r.rank,
                number: r.number,
                score: r.score,
                probability: (r.probability * 100).toFixed(2) + '%',
                grade: r.grade,
              }))}
              cols={[
                { key: 'rank', label: '순위' },
                { key: 'number', label: '번호' },
                { key: 'score', label: '점수' },
                { key: 'probability', label: '출현 가중치' },
                { key: 'grade', label: '등급' },
              ]}
            />
          </Box>

          <Stack direction="row" spacing={2} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
            <Paper sx={{ p: 2, flex: 1, minWidth: 200 }}>
              <Typography fontWeight={700} color="error.main">
                [S등급] 상위10%
              </Typography>
              <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                {(d.grades?.S ?? []).map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
            </Paper>
            <Paper sx={{ p: 2, flex: 1, minWidth: 200 }}>
              <Typography fontWeight={700} color="warning.main">
                [A등급] 상위30%
              </Typography>
              <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                {(d.grades?.A ?? []).map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
            </Paper>
            <Paper sx={{ p: 2, flex: 1, minWidth: 200 }}>
              <Typography fontWeight={700} color="info.main">
                [B등급] 상위60%
              </Typography>
              <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                {(d.grades?.B ?? []).map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
            </Paper>
          </Stack>

          <SectionTitle>
            [추천조합] {recTotal > 0 ? `${recTotal}개` : '최대 20개'}
          </SectionTitle>
          {recTotal === 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              필터 조건을 통과한 추천 조합이 없습니다. (홀짝·구간·합계 조건)
            </Alert>
          )}
          {Object.entries(d.recommendations ?? {}).map(([key, combos]) => {
            const list = combos as { numbers: number[]; expected_score: number; risk: number }[];
            if (!list.length) return null;
            return (
            <Box key={key} sx={{ mb: 2 }}>
              <Typography fontWeight={700} gutterBottom>
                {STRATEGY_LABELS[key] ?? key}
              </Typography>
              {list.map((c, i) => (
                  <Paper key={i} sx={{ p: 1.5, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography sx={{ width: 24 }}>{i + 1})</Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                      {c.numbers.map((n) => (
                        <LottoBall key={n} number={n} size={32} />
                      ))}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      점수 {c.expected_score} · 위험도 {c.risk}
                    </Typography>
                    <CopyButton numbers={c.numbers} />
                  </Paper>
              ))}
            </Box>
            );
          })}
            </>
          )}

          {!hasAnalysis && d.step2_discovery?.no_eligible_data && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              후속출현 분석 데이터가 없습니다. 위 [중복패턴] 표에서 발견 1회 조합을 참고하세요.
              (분석 반영 기준: 2개 이상 조합 + 발견 {d.step2_discovery.min_discovery_threshold}회 이상)
            </Alert>
          )}

          {hasAnalysis && <Divider sx={{ my: 2 }} />}
          {hasAnalysis && (
          <Accordion>
            <AccordionSummary expandIcon={<span>▼</span>}>
              <Typography fontWeight={700}>상세 분석 (패턴·연관·네트워크·유사회차·보너스)</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <PatternAnalysisPanel
                pattern={d.pattern_analysis}
                bonus={d.bonus_analysis}
              />
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                연관 규칙 TOP20
              </Typography>
              <NumTable
                rows={(d.association_rules_top20 ?? []).map((r) => ({
                  antecedent: r.antecedent.join(','),
                  consequent: r.consequent,
                  confidence: r.confidence,
                  lift: r.lift,
                }))}
                cols={[
                  { key: 'antecedent', label: '조건' },
                  { key: 'consequent', label: '후속' },
                  { key: 'confidence', label: 'Confidence' },
                  { key: 'lift', label: 'Lift' },
                ]}
              />
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                유사회차 TOP20
              </Typography>
              <NumTable
                rows={(d.similar_rounds_top20 ?? []).map((r) => ({
                  round: r.round,
                  similarity: r.similarity,
                  jaccard: r.jaccard,
                }))}
                cols={[
                  { key: 'round', label: '회차' },
                  { key: 'similarity', label: '유사도' },
                  { key: 'jaccard', label: 'Jaccard' },
                ]}
              />
              <Typography variant="caption" display="block" sx={{ mt: 2 }} color="text.secondary">
                근거: 매칭 {d.evidence?.match_rounds_used}건 · 백테스트 {d.evidence?.backtest_rounds}
                회 · trusted_only={String(d.evidence?.trusted_only)}
              </Typography>
            </AccordionDetails>
          </Accordion>
          )}
        </>
      )}
    </Box>
  );
}
