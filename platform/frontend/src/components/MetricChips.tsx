import { Chip, Stack, Tooltip } from '@mui/material';
import {
  acValue,
  consecutivePairs,
  decadeBuckets,
  evenCount,
  highCount,
  lastDigitUnique,
  lowCount,
  oddCount,
  sumBand,
  sumTotal,
} from '../utils/comboMetrics';

interface MetricChipsProps {
  numbers: number[];
  /** mt 등 외부 여백 제어를 위한 sx 전달 (선택). */
  dense?: boolean;
}

/**
 * 조합 메트릭 칩 스트립 — 8개 통계 지표 일렬 노출.
 *
 * 본 컴포넌트는 조합을 출력하는 화면들 사이의 시각적 일관성을 위해
 * 공유된다(예: RoundRecommendPage, ComposedAnalysisPage).
 *
 * 칩 7종:
 *   - 합 (sum band 색상)
 *   - 홀:짝
 *   - 고:저 (23 이상)
 *   - AC 값 (등차수열 회피)
 *   - 연속 (개수)
 *   - 끝자리 종류 수
 *   - 십의자리 분포
 */
export default function MetricChips({ numbers, dense = false }: MetricChipsProps) {
  const sum = sumTotal(numbers);
  const band = sumBand(sum);
  const oc = oddCount(numbers);
  const ec = evenCount(numbers);
  const hc = highCount(numbers);
  const lc = lowCount(numbers);
  const ac = acValue(numbers);
  const pairs = consecutivePairs(numbers);
  const ld = lastDigitUnique(numbers);
  const decades = decadeBuckets(numbers);
  const decadeStr = `${decades[0]}-${decades[1]}-${decades[2]}-${decades[3]}-${decades[4]}`;

  const sumColor: 'success' | 'info' | 'warning' =
    band === 'mid' ? 'success' : band === 'low' ? 'info' : 'warning';

  return (
    <Stack
      direction="row"
      spacing={0.5}
      flexWrap="wrap"
      useFlexGap
      sx={{ mt: dense ? 0.5 : 1 }}
    >
      <Tooltip title="6개 번호의 총합. 100~175 구간이 통계적 중앙(p10~p90)">
        <Chip size="small" label={`합 ${sum}`} color={sumColor} variant="filled" />
      </Tooltip>
      <Tooltip title="홀수:짝수 개수. 표준 분포 = 2:4, 3:3, 4:2">
        <Chip size="small" label={`홀:짝 ${oc}:${ec}`} variant="outlined" />
      </Tooltip>
      <Tooltip title="23 이상:22 이하 개수. 표준 분포 = 2:4, 3:3, 4:2">
        <Chip size="small" label={`고:저 ${hc}:${lc}`} variant="outlined" />
      </Tooltip>
      <Tooltip title="Arithmetic Complexity. 등차수열 류 회피 지수 (최대 10, 1등 평균 ≈ 7.4)">
        <Chip
          size="small"
          label={`AC ${ac}`}
          variant="outlined"
          color={ac >= 7 ? 'success' : ac >= 5 ? 'default' : 'warning'}
        />
      </Tooltip>
      <Tooltip
        title={
          pairs.length === 0
            ? '연속된 번호 없음'
            : `연속 쌍: ${pairs.map((p) => p.join('-')).join(', ')}`
        }
      >
        <Chip
          size="small"
          label={pairs.length === 0 ? '연속 0' : `연속 ${pairs.length}`}
          variant="outlined"
          color={pairs.length === 0 ? 'default' : 'warning'}
        />
      </Tooltip>
      <Tooltip title="끝자리(번호 % 10) 종류 수. 3종 이상이면 일자 픽 회피">
        <Chip size="small" label={`끝자리 ${ld}종`} variant="outlined" />
      </Tooltip>
      <Tooltip title="십의자리별 개수 (1자리-10대-20대-30대-40대)">
        <Chip size="small" label={`십 ${decadeStr}`} variant="outlined" />
      </Tooltip>
    </Stack>
  );
}
