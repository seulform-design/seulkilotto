import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Paper,
  Slider,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api } from '../api/v1Api';

export default function SmartPickPage() {
  const [nSets, setNSets] = useState(5);
  const [maxOverlap, setMaxOverlap] = useState(2);
  const [excludeConsecutive, setExcludeConsecutive] = useState(true);

  const smart = useMutation({
    mutationFn: () =>
      v1Api.generateSmart({ nSets, maxOverlap, excludeConsecutive }),
  });

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        스마트 조합
      </Typography>

      <Alert severity="warning" sx={{ mb: 2 }}>
        로또 6/45 당첨 확률은 모든 조합이 동일합니다(약 1/814만).
        이 기능은 <strong>확률을 높이지 않으며</strong>, 조합 다양화·역대 당첨 분포 필터·
        흔한 패턴(생일 번호 등) 회피로 <strong>당첨 시 분할 가능성</strong>을 줄이는 참고용입니다.
      </Alert>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          게임 수: {nSets}개
        </Typography>
        <Slider
          min={1}
          max={10}
          value={nSets}
          onChange={(_, v) => setNSets(v as number)}
          marks
          step={1}
          sx={{ mb: 2 }}
        />
        <Typography variant="subtitle2" gutterBottom>
          게임 간 최대 겹침: {maxOverlap}개 번호
        </Typography>
        <Slider
          min={0}
          max={4}
          value={maxOverlap}
          onChange={(_, v) => setMaxOverlap(v as number)}
          sx={{ mb: 1 }}
        />
        <FormControlLabel
          control={
            <Switch
              checked={excludeConsecutive}
              onChange={(e) => setExcludeConsecutive(e.target.checked)}
            />
          }
          label="연속 번호 제외"
        />
      </Paper>

      <Button
        variant="contained"
        color="success"
        size="large"
        onClick={() => smart.mutate()}
        disabled={smart.isPending}
        sx={{ mb: 2, fontWeight: 800 }}
      >
        {smart.isPending ? <CircularProgress size={24} color="inherit" /> : '스마트 조합 생성'}
      </Button>

      {smart.data?.disclaimer && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {smart.data.disclaimer}
        </Typography>
      )}
      {smart.data?.warning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {smart.data.warning}
        </Alert>
      )}
      {smart.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {smart.error instanceof Error ? smart.error.message : '생성 실패'}
        </Alert>
      )}

      {smart.data?.combinations.map((combo, idx) => (
        <Paper key={idx} sx={{ p: 2, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ width: 24, fontWeight: 800, color: 'text.secondary' }}>
            {idx + 1}
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
            {combo.numbers.map((n) => (
              <LottoBall key={n} number={n} size={36} />
            ))}
          </Stack>
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="caption" color="text.secondary" display="block">
              합{combo.sum_total} · 홀{combo.odd_count}
            </Typography>
            {combo.rarity_score != null && (
              <Typography variant="caption" color="success.main" display="block">
                희귀도 {combo.rarity_score}
              </Typography>
            )}
            <CopyButton numbers={combo.numbers} />
          </Box>
        </Paper>
      ))}

      <Paper sx={{ p: 2, mt: 2, bgcolor: '#262A30' }}>
        <Typography variant="subtitle2" gutterBottom>
          당첨 확률을 실질적으로 높이려면
        </Typography>
        <Typography variant="body2" component="div">
          • <strong>구매 게임 수 증가</strong> — 유일하게 확률이 선형 증가하는 방법
          <br />
          • <strong>번호 휠(Wheel)</strong> — 8~12개 풀에서 여러 6조합 커버 (추후 추가 예정)
          <br />
          • <strong>동일 패턴 회피</strong> — 1~31 생일·연속·끝수 동일 조합은 당첨 시 분할↑
          <br />
          • <strong>백테스트 비교</strong> — 연구 분석 탭에서 전략별 과거 적중률 참고
          <br />• 장기적으론 <strong>기대값이 마이너스</strong>인 게임으로, 오락·참고용이 적합합니다.
        </Typography>
      </Paper>
    </Box>
  );
}
