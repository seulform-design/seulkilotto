/**
 * 번호추천 — 추첨데이터 기반 앙상블 추천 (용지 입력 폐지 후 전용 페이지).
 *
 * 과거 SemiAutoComparePanel 안에 묻혀 있던 /generate/ensemble 추천 UI 를
 * 용지 시스템과 분리해 독립 페이지로 재구성한다. machine/post/classic/parallel/
 * decade 추첨데이터 엔진의 소프트보팅 + 5대 스마트필터 + 공동당첨 회피 결과만 노출.
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import ComboActions from '../components/ComboActions';
import LottoBall from '../components/LottoBall';
import { v1Api } from '../api/v1Api';

type Intent = 'current_round' | 'review';

interface CoselectionInfo {
  avoidance_score: number;
  risk: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  factors: string[];
}

interface EngineEvidence {
  available: boolean;
  rounds?: number;
  hits?: number;
  expected_hits?: number;
  lift?: number;
  p_value?: number;
  significant?: boolean;
}

interface EnsembleResult {
  combinations: {
    numbers: number[];
    sum_total?: number;
    odd_count?: number;
    even_count?: number;
    coselection?: CoselectionInfo;
  }[];
  engine_weights?: Record<string, number>;
  target_round?: number;
  strategy?: string | null;
  disclaimer?: string | null;
  algorithm_version?: string;
  rationale?: {
    engine_evidence?: Record<string, EngineEvidence>;
    weights_significant?: boolean;
    weighting_rule?: string;
    selection_rule?: string;
  };
  diversity?: { mean_shared: number; max_shared: number; unique_numbers: number; random_expected_shared?: number };
  coselection_basis?: string;
}

const GRADE_LABEL: Record<CoselectionInfo['grade'], string> = {
  excellent: '매우 희소',
  good: '희소',
  fair: '보통',
  poor: '인기 편중',
};

const ENGINE_LABEL: Record<string, string> = {
  machine: '추첨기',
  post: '후속출현',
  classic: '클래식',
  parallel: '평행회차',
  decade: '구간',
};

export default function RecommendPage() {
  const [intent, setIntent] = useState<Intent>('current_round');
  const [seed, setSeed] = useState<number>(() => Date.now());

  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: v1Api.getMeta, staleTime: 60_000 });
  const currentRound = metaQuery.data?.current_round;
  const latestRound = metaQuery.data?.latest_round;
  const targetRound = intent === 'current_round' ? currentRound : latestRound;

  const ensembleQuery = useQuery({
    queryKey: ['ensemble', intent, targetRound, seed],
    enabled: targetRound != null,
    queryFn: () =>
      v1Api.generateEnsemble({
        nSets: 5,
        lookback: 10,
        intent,
        targetRound: targetRound as number,
        seed,
      }) as Promise<EnsembleResult>,
  });

  const data = ensembleQuery.data;
  const weights = useMemo(
    () =>
      Object.entries(data?.engine_weights ?? {})
        .filter(([, v]) => (v ?? 0) > 0)
        .sort((a, b) => b[1] - a[1]),
    [data],
  );

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h5" fontWeight={800}>
          🎯 번호추천
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          추첨데이터 기반 앙상블(추첨기·후속·클래식·평행회차·구간) 소프트보팅 + 스마트필터 + 공동당첨 회피.
        </Typography>
      </Box>

      <Alert severity="info" variant="outlined" sx={{ borderRadius: 2 }}>
        로또는 i.i.d.라 <strong>적중 확률(1등 1/8,145,060)은 어떤 방법으로도 올릴 수 없습니다.</strong> 이
        추천은 인기 조합(생일대역·연속·등차·규칙 배열)을 피해 <strong>당첨 시 공동당첨 분할을 줄이는 기대수령액
        최적화</strong>만 수행합니다. 공동선택 회피 점수는 실제 구매 데이터가 없는 <strong>추정치</strong>입니다.
      </Alert>

      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={intent}
          onChange={(_, v: Intent | null) => v && setIntent(v)}
        >
          <ToggleButton value="current_round">이번회차{currentRound ? ` (${currentRound}회)` : ''}</ToggleButton>
          <ToggleButton value="review">복기{latestRound ? ` (${latestRound}회)` : ''}</ToggleButton>
        </ToggleButtonGroup>
        <Button
          variant="contained"
          onClick={() => setSeed(Date.now())}
          disabled={ensembleQuery.isFetching || targetRound == null}
        >
          {ensembleQuery.isFetching ? '생성 중…' : '다시 추천'}
        </Button>
        {data?.target_round != null && (
          <Typography variant="caption" color="text.secondary">
            대상 {data.target_round}회
          </Typography>
        )}
      </Stack>

      {weights.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {weights.map(([k, v]) => (
            <Chip
              key={k}
              size="small"
              label={`${ENGINE_LABEL[k] ?? k} ${v.toFixed(1)}%`}
              variant="outlined"
            />
          ))}
        </Stack>
      )}

      {data?.rationale?.engine_evidence && (
        <Typography variant="caption" color="text.secondary" component="div">
          {data.rationale.weights_significant
            ? '일부 엔진이 다중검정 보정 후에도 무작위보다 유의하게 적중했습니다(소표본 — 재현 확인 필요).'
            : '어떤 엔진도 최근 적중이 무작위보다 유의하지 않아 동일 가중을 사용했습니다(우연 변동을 신호로 쓰지 않음).'}{' '}
          {Object.entries(data.rationale.engine_evidence)
            .filter(([, e]) => e.available)
            .map(([k, e]) => `${ENGINE_LABEL[k] ?? k} ${e.hits}/${e.expected_hits}(p=${e.p_value})`)
            .join(' · ')}
        </Typography>
      )}

      {ensembleQuery.isError && (
        <Alert severity="error">추천 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.</Alert>
      )}

      {ensembleQuery.isFetching && !data && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 4, justifyContent: 'center' }}>
          <CircularProgress size={22} />
          <Typography variant="body2" color="text.secondary">
            앙상블 추천 계산 중…
          </Typography>
        </Stack>
      )}

      <Stack spacing={1.5}>
        {(data?.combinations ?? []).map((c, idx) => (
          <Paper
            key={idx}
            variant="outlined"
            sx={{ p: 1.5, borderRadius: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 28 }}>
              {idx + 1}세트
            </Typography>
            <Stack direction="row" spacing={0.75} sx={{ flexGrow: 1 }}>
              {c.numbers.map((n) => (
                <LottoBall key={n} number={n} size={40} />
              ))}
            </Stack>
            {c.sum_total != null && (
              <Typography variant="caption" color="text.secondary">
                합 {c.sum_total} · 홀{c.odd_count}:짝{c.even_count}
              </Typography>
            )}
            {c.coselection && (
              <Chip
                size="small"
                color={c.coselection.grade === 'poor' ? 'warning' : c.coselection.grade === 'fair' ? 'default' : 'success'}
                variant="outlined"
                label={`공동선택 회피 ${c.coselection.avoidance_score} · ${GRADE_LABEL[c.coselection.grade]}`}
                title={c.coselection.factors.join(', ') || '특이 인기 패턴 없음'}
              />
            )}
            <ComboActions numbers={c.numbers} source="recommend" label={`번호추천 ${idx + 1}세트`} />
          </Paper>
        ))}
      </Stack>

      {data?.diversity && (
        <Typography variant="caption" color="text.secondary">
          세트 다양성: 세트 간 평균 공유 {data.diversity.mean_shared}개(최대 {data.diversity.max_shared}) · 고유 번호{' '}
          {data.diversity.unique_numbers}개
          {data.algorithm_version ? ` · 알고리즘 ${data.algorithm_version}` : ''}
        </Typography>
      )}

      {data?.disclaimer && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {data.disclaimer}
        </Typography>
      )}
    </Stack>
  );
}
