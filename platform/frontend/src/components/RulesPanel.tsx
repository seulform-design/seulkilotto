/**
 * FP-Growth 연관규칙 테이블
 */
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  Button,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api/fetchJson';

export default function RulesPanel() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['rules-fp'],
    queryFn: () =>
      fetchJson<{
        method?: string;
        transactions?: number;
        rules?: Record<string, unknown>[];
        disclaimer?: string;
      }>('/api/rules?method=fpgrowth&min_support=0.015&min_confidence=0.12'),
    enabled: false,
  });

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        FP-Growth 연관규칙
      </Typography>
      <Button variant="outlined" size="small" onClick={() => refetch()} disabled={isFetching}>
        규칙 마이닝 실행
      </Button>
      <Typography variant="caption" display="block" sx={{ mt: 1, mb: 1 }}>
        {data?.method} · 트랜잭션 {data?.transactions ?? '—'}건
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>선행</TableCell>
            <TableCell>결과</TableCell>
            <TableCell>Support</TableCell>
            <TableCell>Conf</TableCell>
            <TableCell>Lift</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data?.rules?.slice(0, 15).map((r: Record<string, unknown>, i: number) => (
            <TableRow key={i}>
              <TableCell>{(r.antecedent as string[])?.join(', ')}</TableCell>
              <TableCell>{(r.consequent as string[])?.join(', ')}</TableCell>
              <TableCell>{r.support as number}</TableCell>
              <TableCell>{r.confidence as number}</TableCell>
              <TableCell>{r.lift as number}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="caption" color="text.secondary">
        {data?.disclaimer}
      </Typography>
    </Paper>
  );
}
