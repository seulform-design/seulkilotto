import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import BulkLineInputDialog from '../components/BulkLineInputDialog';
import LottoBall from '../components/LottoBall';
import NumberFrequencyPanel from '../components/NumberFrequencyPanel';
import ParallelRoundPanel from '../components/ParallelRoundPanel';
import PhotoBacktestPanel from '../components/PhotoBacktestPanel';
import SavedLinesPanel, {
  GAME_LABELS,
  slipFromLines,
  type GameLabel,
  type SavedLine,
} from '../components/SavedLinesPanel';
import SemiAutoComparePanel from '../components/SemiAutoComparePanel';
import {
  v1Api,
  type ComboDuplicatePatterns,
  type CrossLineAnalysisReport,
  type DrawReviewTemplate,
  type ManualSlipInput,
  type PhotoAnalysisAccumulated,
  type PhotoAnalysisIntentSlice,
  type SavedReviewTemplate,
} from '../api/v1Api';

type SheetIntent = 'review' | 'current_round';

function toWinningSet(data?: DrawReviewTemplate | null): Set<number> | null {
  if (!data?.winning_numbers?.length) return null;
  const set = new Set(data.winning_numbers);
  if (data.bonus) set.add(data.bonus);
  return set;
}

function ReviewBall({
  number,
  size,
  winningSet,
}: {
  number: number;
  size?: number;
  winningSet?: Set<number> | null;
}) {
  return (
    <LottoBall
      number={number}
      size={size}
      dimmed={winningSet ? !winningSet.has(number) : false}
    />
  );
}

function DrawWinningTemplatePanel({ data, intentLabel }: { data?: DrawReviewTemplate | null; intentLabel?: string }) {
  if (!data?.winning_numbers?.length) return null;
  return (
    <Paper sx={{ p: 2, border: '1px solid #2e7d32' }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        {data.ticket_round}회 당첨번호 템플릿 ({intentLabel || '복기'})
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {data.summary || `당첨 ${data.winning_numbers.join(', ')} · 보너스 ${data.bonus ?? '-'}`}
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
        {data.winning_numbers.map((n) => (
          <LottoBall key={n} number={n} size={36} />
        ))}
        {data.bonus ? <ReviewBall number={data.bonus} size={36} winningSet={toWinningSet(data)} /> : null}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        수기 5×6 (A~E×6번호) · 2조합 {data.winning_combo_reference?.pair_count ?? 15}개 · 3조합{' '}
        {data.winning_combo_reference?.triple_count ?? 20}개 검증 · 회색 공 = 당첨번호 아님
      </Typography>
    </Paper>
  );
}

function CrossLineAnalysisPanel({
  data,
  winningSet,
}: {
  data?: CrossLineAnalysisReport | null;
  winningSet?: Set<number> | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!data) return null;
  const renderSets = (
    title: string,
    items: CrossLineAnalysisReport['triple_sets'],
    emptyLabel: string,
  ) => (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>
        {title}
      </Typography>
      {!items.length ? (
        <Typography variant="body2" color="text.secondary">
          - {emptyLabel}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {items.map((item) => (
            <Box
              key={item.numbers.join('-')}
              sx={{
                pl: 1.5,
                py: 0.75,
                borderLeft: '3px solid',
                borderColor: 'secondary.main',
                bgcolor: 'action.hover',
                borderRadius: 1,
              }}
            >
              <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" sx={{ mb: 0.5 }}>
                <Typography variant="body2" fontWeight={600} color="text.primary">
                  [{item.numbers.join(', ')}] 세트 (총 {item.appearance_count ?? item.line_count ?? 0}회)
                </Typography>
                {item.numbers.map((n) => (
                  <ReviewBall key={n} number={n} size={28} winningSet={winningSet} />
                ))}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                위치: {(item.locations ?? []).join(', ') || '-'}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );

  const hasSets = (data.triple_sets?.length ?? 0) > 0 || (data.pair_sets?.length ?? 0) > 0;

  return (
    <Paper
      sx={{
        p: 2,
        border: '1px solid',
        borderColor: 'secondary.main',
        bgcolor: 'background.paper',
      }}
    >
      {/* 헤더 — 클릭으로 접기/펼치기 */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((v) => !v)}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={700} color="text.primary">
            이미지·A~E 줄 교차 분석 (2·3번호 세트)
          </Typography>
          <Typography variant="caption" color="text.secondary">
            이미지 {data.image_count}장 · 게임 줄 {data.line_count}개 ·
            세트 {(data.triple_sets?.length ?? 0) + (data.pair_sets?.length ?? 0)}건
            {expanded ? ' · ▼ 접기' : ' · ▶ 펼치기'}
          </Typography>
        </Box>
        <Button size="small" variant="text" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
          {expanded ? '접기' : '펼치기'}
        </Button>
      </Stack>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ mt: 1.5 }}>
          <Stack direction="row" flexWrap="wrap" gap={0.5} alignItems="center" sx={{ mb: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              2회 이상 공동 출현 기준
            </Typography>
            {data.line_label_counts &&
              ['A', 'B', 'C', 'D', 'E'].map((label) =>
                (data.line_label_counts?.[label] ?? 0) > 0 ? (
                  <Chip key={label} label={`${label} ${data.line_label_counts![label]}`} size="small" variant="outlined" />
                ) : null
              )}
          </Stack>
          {!hasSets && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              2회 이상 함께 나온 2·3번호 세트가 없습니다. (줄 {data.line_count}개 분석됨)
            </Alert>
          )}
          {renderSets('■ 1. [3개 세트] 다른 줄에서도 겹치는 3인조', data.triple_sets, '없음')}
          {renderSets('■ 2. [2개 세트] 다른 줄에서도 겹치는 2인조', data.pair_sets, '없음')}
          <Box sx={{ mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="subtitle2" fontWeight={700} gutterBottom color="text.primary">
              ■ 3. 교차 분석 종합 의견
            </Typography>
            <Typography variant="body2" color="text.primary">
              {data.summary_opinion}
            </Typography>
          </Box>
        </Box>
      </Collapse>
    </Paper>
  );
}

function ComboDuplicatePanel({
  data,
  mode = 'review',
  winningSet,
}: {
  data?: ComboDuplicatePatterns | null;
  mode?: 'review' | 'current_round';
  winningSet?: Set<number> | null;
}) {
  const hasSameLine = (data?.same_line_matches?.length ?? 0) > 0;
  const hasCross =
    (data?.pair_duplicates?.length ?? 0) > 0
    || (data?.triple_duplicates?.length ?? 0) > 0
    || (data?.quad_duplicates?.length ?? 0) > 0;

  if (!data || (!hasSameLine && !hasCross)) {
    return (
      <Typography variant="body2" color="text.secondary">
        {mode === 'current_round'
          ? '게임 줄 간 2·3·4번호 겹침 또는 복기 기준번호 일치 줄이 없습니다.'
          : '당첨번호와 2개 이상 일치하는 게임 줄이 없습니다.'}
      </Typography>
    );
  }
  const ver = data.combo_verification;

  // 모든 항목 노출 — 상한 제거. 50건 이상이면 스크롤 컨테이너로 페이지 길이 방어.
  const renderCross = (items: ComboDuplicatePatterns['pair_duplicates'], title: string) =>
    items?.length ? (
      <Box>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
          {title} ({items.length}건 전체)
        </Typography>
        <Box
          sx={{
            maxHeight: items.length > 20 ? 360 : undefined,
            overflowY: items.length > 20 ? 'auto' : undefined,
            bgcolor: items.length > 20 ? 'action.hover' : undefined,
            borderRadius: 1,
            p: items.length > 20 ? 0.5 : 0,
          }}
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>번호 조합</TableCell>
                <TableCell>겹친 줄 수</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((row) => (
                <TableRow key={`${title}-${row.numbers.join('-')}`}>
                  <TableCell>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {row.numbers.map((n) => (
                        <ReviewBall key={n} number={n} size={28} winningSet={mode === 'review' ? winningSet : null} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>{row.repeat_count ?? row.line_count ?? 0}줄</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Box>
    ) : null;

  const renderSameLine = () => {
    const matches = data.same_line_matches ?? [];
    if (!matches.length) return null;
    return (
      <Box>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
          {mode === 'review' ? '당첨번호 vs 게임 줄 일치' : '복기 기준번호 vs 게임 줄 일치'} ({matches.length}줄 전체)
        </Typography>
        <Box
          sx={{
            maxHeight: matches.length > 25 ? 400 : undefined,
            overflowY: matches.length > 25 ? 'auto' : undefined,
            bgcolor: matches.length > 25 ? 'action.hover' : undefined,
            borderRadius: 1,
            p: matches.length > 25 ? 0.5 : 0,
          }}
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>용지·줄</TableCell>
                <TableCell>일치 번호</TableCell>
                <TableCell>등급</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {matches.map((row) => (
                <TableRow key={`${row.sheet_index}-${row.line_index}-${row.matching_numbers.join('-')}`}>
                  <TableCell>
                    이미지 {(row as { image_index?: number }).image_index ?? row.sheet_index + 1} · {row.line_label}줄
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {row.matching_numbers.map((n) => (
                        <ReviewBall key={n} number={n} size={28} winningSet={mode === 'review' ? winningSet : null} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>{row.prize_tier} ({row.overlap_count}개)</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Box>
    );
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">{data.summary}</Typography>
      {ver && (
        <Alert severity="info" sx={{ py: 0.5 }}>
          검증: 게임 줄 {ver.lines_analyzed ?? data.line_count ?? '-'}개 (용지 {ver.physical_sheets_detected ?? ver.sheets_analyzed}장)
          {ver.images_uploaded ? ` · 사진 ${ver.images_uploaded}장` : ''}
          · {ver.criteria}
          {(ver.raw_pair_candidates ?? 0) > (ver.significant_pairs ?? 0) && (
            <>
              <br />
              (줄간 2번호 후보 {ver.raw_pair_candidates}건 → 기준 적용 후 {ver.significant_pairs}건)
            </>
          )}
        </Alert>
      )}
      {renderSameLine()}
      {renderCross(data.pair_duplicates, '다른 줄에도 겹침 — 2번호 (2줄 이상)')}
      {renderCross(data.triple_duplicates, '다른 줄에도 겹침 — 3번호 (2줄 이상)')}
      {renderCross(data.quad_duplicates ?? [], '다른 줄에도 겹침 — 4번호 (2줄 이상)')}
    </Stack>
  );
}

function SavedReviewTemplatePanel({
  data,
  winningSet,
}: {
  data?: SavedReviewTemplate | null;
  winningSet?: Set<number> | null;
}) {
  if (!data?.marked_numbers?.length) return null;
  return (
    <Paper sx={{ p: 2, border: '1px dashed #666' }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        저장된 복기 위치 템플릿
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {data.ticket_rounds?.length ? `${data.ticket_rounds.join(', ')}회 · ` : ''}
        {data.source_count}건 복기 분석 · 번호 {data.marked_numbers.length}개
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={1}>
        {data.marked_numbers.map((n) => (
          <ReviewBall key={n} number={n} size={30} winningSet={winningSet} />
        ))}
      </Stack>
    </Paper>
  );
}

function IntentAccumulatedPanel({
  slice,
  intent,
  legacyCount,
  onDeleteEntry,
}: {
  slice?: PhotoAnalysisIntentSlice | null;
  intent: SheetIntent;
  legacyCount?: number;
  onDeleteEntry: (id: string) => void;
}) {
  if (!slice?.total_analyses) {
    return (
      <Alert severity="info">
        {intent === 'review'
          ? '복기 탭에 저장된 분석이 없습니다. 당첨번호 검증용 용지를 등록·분석하세요.'
          : '이번회차 탭에 저장된 분석이 없습니다. A~E 줄을 등록한 뒤 분석·저장하세요.'}
      </Alert>
    );
  }

  const comboTitle =
    intent === 'review' ? '누적 — 당첨번호 vs 게임 줄' : '누적 — 게임 줄 겹침';
  const winningSet = intent === 'review' ? toWinningSet(slice.draw_template) : null;

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2, border: intent === 'review' ? '1px solid #2e7d32' : '1px solid #1565c0' }}>
        <Typography variant="h6" fontWeight={700} gutterBottom>
          {slice.video_intent_label} 누적 ({slice.ticket_round}회)
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          {slice.app_ui_message}
        </Typography>
        <Chip label={`${slice.video_intent_label} ${slice.total_analyses}건`} size="small" color={intent === 'review' ? 'primary' : 'secondary'} />
      </Paper>
      {(legacyCount ?? 0) > 0 && intent === 'review' && (
        <Alert severity="warning">구형 복기 데이터 {legacyCount}건 — 누적 삭제 후 다시 분석하세요.</Alert>
      )}
      {intent === 'review' && slice.draw_template && (
        <DrawWinningTemplatePanel data={slice.draw_template} intentLabel="복기" />
      )}
      {intent === 'review' && (
        <SavedReviewTemplatePanel data={slice.saved_review_template} winningSet={winningSet} />
      )}
      {slice.accumulated_combo_patterns?.cross_line_analysis && (
        <CrossLineAnalysisPanel
          data={slice.accumulated_combo_patterns.cross_line_analysis}
          winningSet={winningSet}
        />
      )}
      {slice.accumulated_combo_patterns &&
        (slice.accumulated_combo_patterns.same_line_matches?.length ||
          slice.accumulated_combo_patterns.pair_duplicates?.length ||
          slice.accumulated_combo_patterns.triple_duplicates?.length ||
          slice.accumulated_combo_patterns.quad_duplicates?.length) ? (
        <Paper sx={{ p: 2, border: '1px solid #5c4d00' }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            {comboTitle}
          </Typography>
          <ComboDuplicatePanel
            data={slice.accumulated_combo_patterns}
            mode={intent}
            winningSet={winningSet}
          />
        </Paper>
      ) : null}
    </Stack>
  );
}

/**
 * 백엔드 누적 분석 이력 테이블 — IntentAccumulatedPanel 에서 분리하여
 * 페이지 가장 하단 (§4 고급 설정 다음) 으로 배치 (사용자 요청).
 * 다른 누적 분석 결과 (당첨번호 vs 게임줄 / 강한 후보 / 빈도 등) 와
 * 시각적 분리하여 데이터 관리 영역으로 노출.
 */
function HistoryEntriesPanel({
  slice,
  onDeleteEntry,
}: {
  slice?: PhotoAnalysisIntentSlice | null;
  onDeleteEntry: (id: string) => void;
}) {
  if (!slice?.entries_summary?.length) return null;
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        {slice.video_intent_label} 분석 이력 ({slice.entries_summary.length}건)
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>용지</TableCell>
            <TableCell>회차</TableCell>
            <TableCell>분석 시각</TableCell>
            <TableCell align="right">삭제</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {slice.entries_summary.map((e) => (
            <TableRow key={e.id}>
              <TableCell sx={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.video_title || e.url}
              </TableCell>
              <TableCell>{e.ticket_round ? `${e.ticket_round}회` : '-'}</TableCell>
              <TableCell>
                {e.analyzed_at
                  ? new Date(e.analyzed_at).toLocaleString('ko-KR', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '-'}
              </TableCell>
              <TableCell align="right">
                <IconButton size="small" color="error" onClick={() => onDeleteEntry(e.id)} aria-label="삭제">
                  ×
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

const GRID_NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);
const GRID_COLS = 7;

function parseRoundNo(value?: string | number | null): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseInt(String(value).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ManualNumberGrid({
  picked,
  onToggle,
  currentLabel,
}: {
  picked: number[];
  onToggle: (n: number) => void;
  currentLabel: GameLabel;
}) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={700}>
          {currentLabel}줄 · {picked.length}/6
        </Typography>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {picked.map((n) => (
            <LottoBall key={n} number={n} size={32} neutral />
          ))}
        </Stack>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gap: 0.75,
          p: 1.5,
          borderRadius: 2,
          bgcolor: 'action.hover',
        }}
      >
        {GRID_NUMBERS.map((n) => {
          const selected = picked.includes(n);
          return (
            <Box
              key={n}
              onClick={() => onToggle(n)}
              sx={{
                display: 'flex',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: selected ? 1 : 0.55,
                transform: selected ? 'scale(1.05)' : 'scale(1)',
                transition: 'transform 0.12s ease, opacity 0.12s ease',
              }}
            >
              <LottoBall number={n} size={36} dimmed={!selected} neutral />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ── 매뉴얼 입력 영속화 (localStorage) ───────────────────────────
// 사용자가 입력한 picked / currentSlipLines / slipQueue 를 영속 저장.
// 다른 탭으로 이동했다 돌아와도, 새로고침해도 보존됨.
// '용지 초기화' / '누적 삭제' / 사용자가 직접 비우는 경우에만 사라진다.
const MANUAL_STORAGE_KEY = 'lotto:photoAnalysis:manual:v1';

type ManualDraft = {
  picked: number[];
  currentSlipLines: SavedLine[];
  slipQueue: ManualSlipInput[];
  /**
   * 자동 [⬆ 대량 입력 (텍스트)] 결과 — 반자동의 bulkTickets 와 동등 구조.
   * slipQueue 와 별개로 보관되어 [분석·저장] 후에도 보존된다.
   * 분석 시에는 5줄/용지로 묶어 slipQueue 와 함께 백엔드로 전송.
   */
  bulkAutoTickets: number[][];
};

const emptyManualDraft = (): ManualDraft => ({
  picked: [],
  currentSlipLines: [],
  slipQueue: [],
  bulkAutoTickets: [],
});

const emptyManualByIntent = (): Record<SheetIntent, ManualDraft> => ({
  review: emptyManualDraft(),
  current_round: emptyManualDraft(),
});

function loadManualByIntent(): Record<SheetIntent, ManualDraft> {
  if (typeof window === 'undefined') return emptyManualByIntent();
  try {
    const raw = window.localStorage.getItem(MANUAL_STORAGE_KEY);
    if (!raw) return emptyManualByIntent();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyManualByIntent();
    const out = emptyManualByIntent();
    for (const key of ['review', 'current_round'] as const) {
      const d = (parsed as Record<string, unknown>)[key];
      if (
        d &&
        typeof d === 'object' &&
        Array.isArray((d as ManualDraft).picked) &&
        Array.isArray((d as ManualDraft).currentSlipLines) &&
        Array.isArray((d as ManualDraft).slipQueue)
      ) {
        const draft = d as ManualDraft & { bulkAutoTickets?: unknown };
        const bulkAutoTickets: number[][] = Array.isArray(draft.bulkAutoTickets)
          ? (draft.bulkAutoTickets as unknown[])
              .filter((t): t is number[] => Array.isArray(t))
              .map((t) =>
                t.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 45)
              )
              .filter((t) => t.length === 6)
          : [];
        out[key] = {
          picked: draft.picked.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45),
          currentSlipLines: draft.currentSlipLines,
          slipQueue: draft.slipQueue,
          bulkAutoTickets,
        };
      }
    }
    return out;
  } catch {
    return emptyManualByIntent();
  }
}

function saveManualByIntent(state: Record<SheetIntent, ManualDraft>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
}

// ── 중복 검사 헬퍼 ───────────────────────────────────────────────
// 같은 6-튜플(정렬 기준)이 이미 저장돼 있는지 확인.
// 만약 발견되면 어느 위치에서 발견됐는지 정보 반환.
const dupKey = (nums: number[]): string =>
  [...nums].sort((a, b) => a - b).join('-');

type DuplicateLocation =
  | { foundIn: 'current'; lineLabel: string }
  | { foundIn: 'queue'; slipIdx: number; lineLabel: string }
  | { foundIn: 'bulkAuto'; ticketIdx: number };

function findDuplicateInState(
  numbers: number[],
  currentSlipLines: SavedLine[],
  slipQueue: ManualSlipInput[],
  bulkAutoTickets: number[][] = []
): DuplicateLocation | null {
  const key = dupKey(numbers);
  for (const line of currentSlipLines) {
    if (dupKey(line.numbers) === key) {
      return { foundIn: 'current', lineLabel: line.label };
    }
  }
  for (let slipIdx = 0; slipIdx < slipQueue.length; slipIdx++) {
    const slip = slipQueue[slipIdx];
    for (const line of slip.lines) {
      if (dupKey(line.numbers) === key) {
        return { foundIn: 'queue', slipIdx, lineLabel: line.label };
      }
    }
  }
  // bulkAutoTickets 도 자동 그룹의 동등 데이터 소스 — groupSetIntersection
  // 카운트 부풀림 방지 위해 함께 검사. 누락 시 같은 6번호가 그리드 [줄 저장] +
  // 대량 입력 양쪽에 존재 가능 → autoCount 2배.
  for (let i = 0; i < bulkAutoTickets.length; i += 1) {
    if (dupKey(bulkAutoTickets[i]) === key) {
      return { foundIn: 'bulkAuto', ticketIdx: i };
    }
  }
  return null;
}

function formatDuplicateLocation(loc: DuplicateLocation): string {
  if (loc.foundIn === 'current') {
    return `입력 중인 ${loc.lineLabel}줄`;
  }
  if (loc.foundIn === 'queue') {
    return `용지 ${loc.slipIdx + 1}의 ${loc.lineLabel}줄`;
  }
  return `대량 입력 #${loc.ticketIdx + 1}`;
}

export default function PhotoAnalysisPage() {
  const [activeTab, setActiveTab] = useState<SheetIntent>('review');
  const [manualByIntent, setManualByIntent] = useState<Record<SheetIntent, ManualDraft>>(
    loadManualByIntent
  );

  // localStorage 영속 — 변경 시마다 자동 저장
  useEffect(() => {
    saveManualByIntent(manualByIntent);
  }, [manualByIntent]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  // 비동기 작업 중 unmount 가드 (메모리 안정성)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<PhotoAnalysisAccumulated | null>(null);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [useVisionApi, setUseVisionApi] = useState(false);
  const [showVisionAdvanced, setShowVisionAdvanced] = useState(false);
  const [visionKey, setVisionKey] = useState('');
  const [visionSaving, setVisionSaving] = useState(false);
  const [visionSaveMsg, setVisionSaveMsg] = useState<string | null>(null);

  const metaQuery = useQuery({
    queryKey: ['v1-meta'],
    queryFn: v1Api.getMeta,
    staleTime: 60_000,
  });
  const roundStatusQuery = useQuery({
    queryKey: ['v1-round-status'],
    queryFn: v1Api.getRoundStatus,
    staleTime: 60_000,
  });

  const refreshAccumulated = useCallback(async () => {
    try {
      setAccumulated(await v1Api.getPhotoAnalysisAccumulated());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshAccumulated();
    v1Api
      .getPhotoVisionConfig()
      .then((c) => {
        if (!mountedRef.current) return;
        setVisionConfigured(c.configured);
        setUseVisionApi(Boolean(c.use_vision_api));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setVisionConfigured(false);
        setUseVisionApi(false);
      });
  }, [refreshAccumulated]);

  const activeSlice = accumulated?.by_intent?.[activeTab] ?? null;

  const latestRound = useMemo(() => {
    const fromStatus = roundStatusQuery.data?.review_round ?? roundStatusQuery.data?.latest_round;
    if (fromStatus && fromStatus > 0) return fromStatus;
    const fromMeta = metaQuery.data?.latest_round;
    if (fromMeta && fromMeta > 0) return fromMeta;
    const fromReviewSlice = parseRoundNo(accumulated?.by_intent?.review?.ticket_round);
    if (fromReviewSlice) return fromReviewSlice;
    const fromTemplate = parseRoundNo(accumulated?.by_intent?.review?.draw_template?.ticket_round);
    if (fromTemplate) return fromTemplate;
    return null;
  }, [roundStatusQuery.data, metaQuery.data, accumulated]);

  const currentRound = useMemo(() => {
    const fromStatus = roundStatusQuery.data?.current_round;
    if (fromStatus && fromStatus > 0) return fromStatus;
    const fromMeta = metaQuery.data?.current_round ?? metaQuery.data?.next_round;
    if (fromMeta && fromMeta > 0) return fromMeta;
    const fromCurrentSlice = parseRoundNo(accumulated?.by_intent?.current_round?.ticket_round);
    if (fromCurrentSlice) return fromCurrentSlice;
    if (latestRound) return latestRound + 1;
    return null;
  }, [roundStatusQuery.data, metaQuery.data, accumulated, latestRound]);

  const roundDrawn = roundStatusQuery.data?.drawn ?? false;

  const reviewWinningSet = useMemo(() => {
    if (activeTab !== 'review') return null;
    return toWinningSet(activeSlice?.draw_template);
  }, [activeTab, activeSlice?.draw_template]);

  const reviewDrawQuery = useQuery({
    queryKey: ['v1-round-draw', latestRound],
    queryFn: () => v1Api.getRound(latestRound as number),
    enabled: activeTab === 'review' && latestRound != null && !reviewWinningSet,
    staleTime: 300_000,
  });

  const activeReviewWinningSet = useMemo(() => {
    if (activeTab !== 'review') return null;
    if (reviewWinningSet) return reviewWinningSet;
    const draw = reviewDrawQuery.data;
    if (!draw?.numbers?.length) return null;
    const set = new Set(draw.numbers);
    if (draw.bonus) set.add(draw.bonus);
    return set;
  }, [activeTab, reviewWinningSet, reviewDrawQuery.data]);

  const displayReviewRound = latestRound ?? '…';
  const displayCurrentRound = currentRound ?? '…';
  const manualDraft = manualByIntent[activeTab];
  const { picked, currentSlipLines, slipQueue, bulkAutoTickets } = manualDraft;

  const patchManual = (patch: Partial<ManualDraft>) => {
    setManualByIntent((prev) => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], ...patch },
    }));
  };

  const currentLabel = GAME_LABELS[currentSlipLines.length] ?? 'A';

  const togglePicked = (n: number) => {
    const prev = picked;
    const next = prev.includes(n)
      ? prev.filter((x) => x !== n)
      : prev.length >= 6
        ? prev
        : [...prev, n].sort((a, b) => a - b);
    patchManual({ picked: next });
  };

  const resetPicked = () => patchManual({ picked: [] });

  const resetCurrentSlip = () => {
    patchManual({ picked: [], currentSlipLines: [] });
    setNotice('입력 중인 용지를 초기화했습니다.');
  };

  const saveCurrentLine = () => {
    if (picked.length !== 6) {
      setError(`${currentLabel}줄: 번호 6개를 선택하세요 (현재 ${picked.length}개).`);
      return;
    }
    const sortedPicked = [...picked].sort((a, b) => a - b);

    // 중복 검사 — 이미 저장된 줄과 동일한 6-튜플인지 확인.
    // 자동 그룹의 3개 소스 (currentSlipLines + slipQueue + bulkAutoTickets) 모두
    // 검사해서 groupSetIntersection autoCount 부풀림 방지.
    // 발견 시 사용자에게 확인 다이얼로그 노출 (그래도 추가 허용).
    const duplicate = findDuplicateInState(
      sortedPicked,
      currentSlipLines,
      slipQueue,
      bulkAutoTickets
    );
    if (duplicate) {
      const where = formatDuplicateLocation(duplicate);
      const ok = window.confirm(
        `이 6개 번호 조합 (${sortedPicked.join(', ')})은 이미 ${where}에 있습니다.\n` +
          `그래도 ${currentLabel}줄로 추가할까요?`
      );
      if (!ok) {
        setError(`중복으로 ${currentLabel}줄 저장 취소됨. 번호를 바꿔서 다시 시도하세요.`);
        return;
      }
    }

    const line: SavedLine = { label: currentLabel, numbers: sortedPicked };
    const nextLines = [...currentSlipLines, line];
    setError(null);
    if (nextLines.length >= GAME_LABELS.length) {
      patchManual({
        picked: [],
        currentSlipLines: [],
        slipQueue: [...slipQueue, slipFromLines(nextLines)],
      });
      setNotice(`용지 ${slipQueue.length + 1}장 저장됨 (A~E 완료)`);
      return;
    }
    patchManual({ picked: [], currentSlipLines: nextLines });
    setNotice(`${currentLabel}줄 저장 — 다음 ${GAME_LABELS[nextLines.length]}줄`);
  };

  /**
   * 대량 입력 처리 — 중복 자동 필터.
   *
   * 처리 순서:
   *   1. 기존 currentSlipLines / slipQueue 의 모든 6-튜플 키 수집
   *   2. 입력 lines 를 순회하며:
   *      - 기존 상태와 중복 → 'external' 카운트, 제외
   *      - 같은 입력 안에서 이미 본 줄 → 'internal' 카운트, 제외
   *      - 그 외 → freshLines 에 추가
   *   3. freshLines 만 5줄씩 슬립화하여 append
   *   4. 결과 메시지에 필터링된 카운트 명시
   */
  const handleBulkInsert = (lines: number[][]) => {
    if (!lines.length) return;

    // 중복 검사 대상: 입력 중·저장 용지·기존 대량 입력 모두.
    const existingKeys = new Set<string>();
    for (const l of currentSlipLines) existingKeys.add(dupKey(l.numbers));
    for (const slip of slipQueue) {
      for (const l of slip.lines) existingKeys.add(dupKey(l.numbers));
    }
    for (const t of bulkAutoTickets) existingKeys.add(dupKey(t));

    const freshLines: number[][] = [];
    const seenInBulk = new Set<string>();
    let externalDupCount = 0;
    let internalDupCount = 0;

    for (const nums of lines) {
      const sorted = [...nums].sort((a, b) => a - b);
      const key = dupKey(sorted);
      if (existingKeys.has(key)) {
        externalDupCount += 1;
        continue;
      }
      if (seenInBulk.has(key)) {
        internalDupCount += 1;
        continue;
      }
      seenInBulk.add(key);
      freshLines.push(sorted);
    }

    if (freshLines.length === 0) {
      setError(
        `입력 ${lines.length}줄 모두 중복으로 제외 (기존 ${externalDupCount} · 입력 내 ${internalDupCount}). 추가된 줄이 없습니다.`
      );
      return;
    }

    // 자동도 반자동처럼 bulkAutoTickets 별도 구조에 보관.
    // slipQueue 와 분리되어 [분석·저장] 후에도 보존됨.
    patchManual({ bulkAutoTickets: [...bulkAutoTickets, ...freshLines] });
    setError(null);

    let msg = `${freshLines.length}줄 대량 추가 완료 (대량 누적 ${bulkAutoTickets.length + freshLines.length}장)`;
    if (externalDupCount > 0) msg += ` · 기존 중복 ${externalDupCount}줄 제외`;
    if (internalDupCount > 0) msg += ` · 입력 내 중복 ${internalDupCount}줄 제외`;
    setNotice(msg);
  };

  const removeCurrentLine = (idx: number) => {
    if (idx < 0 || idx >= currentSlipLines.length) return;
    const removedLabel = currentSlipLines[idx].label;
    const next = currentSlipLines
      .filter((_, i) => i !== idx)
      .map((line, i) => ({ ...line, label: GAME_LABELS[i] }));
    patchManual({ currentSlipLines: next });
    setError(null);
    setNotice(`${removedLabel}줄 삭제 — 다음 입력은 ${GAME_LABELS[next.length] ?? 'A'}줄`);
  };

  const editCurrentLine = (idx: number) => {
    if (idx < 0 || idx >= currentSlipLines.length) return;
    const line = currentSlipLines[idx];
    if (picked.length > 0) {
      const ok = window.confirm(
        `편집 중인 번호 ${picked.length}개가 있습니다.\n` +
          `${line.label}줄을 편집하려면 현재 선택은 사라집니다. 진행할까요?`
      );
      if (!ok) return;
    }
    const next = currentSlipLines
      .filter((_, i) => i !== idx)
      .map((l, i) => ({ ...l, label: GAME_LABELS[i] }));
    patchManual({
      currentSlipLines: next,
      picked: [...line.numbers].sort((a, b) => a - b),
    });
    setError(null);
    setNotice(`${line.label}줄을 편집합니다. 번호 수정 후 「줄 저장」을 누르세요.`);
  };

  const removeSlipLine = (slipIdx: number, lineIdx: number) => {
    if (slipIdx < 0 || slipIdx >= slipQueue.length) return;
    const target = slipQueue[slipIdx];
    if (lineIdx < 0 || lineIdx >= target.lines.length) return;
    const removedLabel = target.lines[lineIdx].label;
    const newLines = target.lines
      .filter((_, li) => li !== lineIdx)
      .map((l, li) => ({ ...l, label: GAME_LABELS[li] }));
    const nextQueue = slipQueue
      .map((slip, si) => (si === slipIdx ? { ...slip, lines: newLines } : slip))
      .filter((slip) => slip.lines.length > 0);
    patchManual({ slipQueue: nextQueue });
    setError(null);
    setNotice(
      newLines.length
        ? `용지 ${slipIdx + 1}의 ${removedLabel}줄 삭제 (남은 줄: ${newLines.length})`
        : `용지 ${slipIdx + 1}이 비어 자동 삭제됨`
    );
  };

  const runManualAnalyze = async () => {
    let slips = [...slipQueue];
    // 부분 용지(1~4줄)도 자동으로 슬립화하여 분석 — "저장이 안 됨" 결함 해소
    if (currentSlipLines.length > 0) {
      slips = [...slips, slipFromLines(currentSlipLines)];
    }
    // bulkAutoTickets 도 5줄/용지로 묶어 함께 분석에 포함.
    // 분석 후에도 bulkAutoTickets 는 보존되어 추가 세팅에 계속 표시됨.
    if (bulkAutoTickets.length > 0) {
      for (let i = 0; i < bulkAutoTickets.length; i += GAME_LABELS.length) {
        const chunk = bulkAutoTickets.slice(i, i + GAME_LABELS.length);
        const chunkLines: SavedLine[] = chunk.map((numbers, idx) => ({
          label: GAME_LABELS[idx],
          numbers,
        }));
        slips.push(slipFromLines(chunkLines));
      }
    }
    if (!slips.length) {
      setError('저장된 줄이 없습니다. 번호 6개 선택 후 「줄 저장」을 누르세요.');
      return;
    }
    setManualLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await v1Api.analyzeManualSlips(slips, { sheetIntent: activeTab, persist: true });
      if (!mountedRef.current) return;
      if (data.accumulated) setAccumulated(data.accumulated);
      if (data.duplicate_skipped) {
        setError(data.duplicate_message || '이미 등록된 용지입니다.');
      } else {
        patchManual({ slipQueue: [], currentSlipLines: [], picked: [] });
        setNotice(`✅ ${slips.length}장 분석·저장 완료 — 결과는 페이지 하단`);
      }
      await refreshAccumulated();
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : '분석 실패 — 저장된 줄은 유지됩니다.');
    } finally {
      if (mountedRef.current) setManualLoading(false);
    }
  };

  const deleteHistoryEntry = async (entryId: string) => {
    if (!window.confirm('이 분석 기록을 삭제할까요?')) return;
    try {
      const res = await v1Api.deletePhotoAnalysisEntry(entryId);
      setAccumulated(res.accumulated);
      setNotice('분석 기록을 삭제했습니다.');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  const clearStore = async () => {
    const targetLabel = activeTab === 'review' ? '복기 탭' : '이번회차 탭';
    if (!window.confirm(`${targetLabel}의 서버 분석 데이터와 자동 입력 누적만 삭제할까요? 다른 탭 데이터는 유지됩니다.`)) return;
    try {
      await v1Api.clearPhotoAnalysisStore(activeTab);
      setManualByIntent((prev) => ({
        ...prev,
        [activeTab]: emptyManualDraft(),
      }));
      await refreshAccumulated();
      setNotice(`${targetLabel} 데이터가 삭제되었습니다.`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  return (
    <Stack spacing={2}>
      {/* ━━ 헤더 ━━ — 누적 삭제는 §1/§3 각 영역의 추가 세팅으로 분리 */}
      <Stack spacing={0.25}>
        <Typography variant="h5" fontWeight={800}>
          자동번호 용지 분석
        </Typography>
        <Typography variant="caption" color="text.secondary">
          복기·이번회차 누적 분석 + 반자동 비교 + 백테스트
        </Typography>
      </Stack>

      {/* ━━ 회차 탭 ━━ */}
      <Paper sx={{ px: 1, pt: 1 }}>
        <Tabs
          value={activeTab}
          onChange={(_, v: SheetIntent) => {
            setActiveTab(v);
            setError(null);
            setNotice(null);
          }}
          variant="fullWidth"
        >
          <Tab
            value="review"
            label={`복기 (${displayReviewRound}회 당첨)`}
            sx={{ fontWeight: activeTab === 'review' ? 700 : 400 }}
          />
          <Tab
            value="current_round"
            label={
              roundDrawn
                ? `이번회차 (${displayCurrentRound}회) ⚠️`
                : `이번회차 (${displayCurrentRound}회)`
            }
            sx={{
              fontWeight: activeTab === 'current_round' ? 700 : 400,
              color: roundDrawn && activeTab !== 'current_round' ? 'warning.main' : undefined,
            }}
          />
        </Tabs>
      </Paper>

      {/* ━━ 안내 (탭 + 입력 방법 통합) ━━ */}
      {(metaQuery.isError || roundStatusQuery.isError) && latestRound == null && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          회차 정보를 불러오지 못했습니다. 네트워크·API 연결을 확인한 뒤 새로고침해 주세요.
        </Alert>
      )}
      <Alert severity="info">
        <Stack spacing={0.5}>
          <Typography variant="body2">
            {activeTab === 'review' ? (
              <><strong>복기 탭</strong> — {displayReviewRound}회 <strong>당첨번호</strong>와 수기 등록 <strong>A~E 줄</strong> 일치 확인. 다른 줄에 겹치는 2·3·4번호 조합도 표시합니다.</>
            ) : (
              <><strong>이번회차 탭</strong> — {displayCurrentRound}회 수기 등록 <strong>A~E 줄</strong>의 <strong>다른 줄·다른 용지</strong> 겹침 (2·3·4번호) 을 검사합니다.</>
            )}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            번호 6개 선택 → <strong>줄 저장</strong> (A→B→C→D→E). 5줄이 모이면 용지 1장 누적. 여러 장 후 <strong>분석·저장</strong>.
          </Typography>
        </Stack>
      </Alert>

      {/* ══ 당첨 발표 후 알림 배너 (이번회차 탭 한정) ══ */}
      {activeTab === 'current_round' && roundDrawn && (
        <Alert
          severity="warning"
          sx={{ mt: 1, fontWeight: 600 }}
          action={
            <Button
              type="button"
              color="warning"
              size="small"
              variant="outlined"
              onClick={() => setActiveTab('review')}
            >
              복기 탭으로 이동
            </Button>
          }
        >
          🎯 <strong>{currentRound}회 당첨번호가 발표됐습니다.</strong>{' '}
          이번회차 탭에 등록한 번호는 이제 <strong>복기 탭</strong>에서 당첨번호와 비교할 수 있습니다.
          <br />
          <Typography variant="caption" color="text.secondary">
            복기 탭 → {latestRound}회 당첨번호 기준 비교 | 이번회차 탭 → {currentRound}회 (미추첨)
          </Typography>
        </Alert>
      )}

      {/* ════════════ § 1. 번호 입력 ════════════ */}
      <Divider textAlign="left" sx={{ mt: 1 }}>
        <Typography variant="overline" fontWeight={800} color="primary.main" sx={{ letterSpacing: 1.2 }}>
          § 1. 번호 입력
        </Typography>
      </Divider>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            📋 구입번호 직접입력 <Typography component="span" variant="caption" color="text.secondary">(자동)</Typography>
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button type="button" size="small" onClick={(e) => { e.preventDefault(); e.stopPropagation(); resetPicked(); }}>
              초기화
            </Button>
            <Button
              type="button"
              size="small"
              variant="contained"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); saveCurrentLine(); }}
              disabled={picked.length !== 6}
            >
              줄 저장
            </Button>
          </Stack>
        </Stack>
        <ManualNumberGrid
          picked={picked}
          onToggle={togglePicked}
          currentLabel={currentLabel}
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }}>
          <Button type="button" variant="outlined" color="inherit" onClick={resetCurrentSlip}>
            용지 초기화
          </Button>
          <Button type="button" variant="outlined" color="primary" onClick={() => setBulkOpen(true)}>
            ⬆ 대량 입력 (반자동 500줄+)
          </Button>
          <Button
            type="button"
            variant="contained"
            color="success"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void runManualAnalyze();
            }}
            disabled={manualLoading || (
              slipQueue.length === 0 &&
              currentSlipLines.length === 0 &&
              bulkAutoTickets.length === 0
            )}
            sx={{ minWidth: 180 }}
          >
            {(() => {
              if (manualLoading) {
                return <><CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />저장 중…</>;
              }
              const totalLines =
                currentSlipLines.length +
                slipQueue.reduce((s, sl) => s + sl.lines.length, 0) +
                bulkAutoTickets.length;
              const label = activeTab === 'review' ? '복기 분석·저장' : '이번회차 분석·저장';
              return totalLines > 0
                ? `💾 ${label} (${totalLines}줄)`
                : `💾 ${label}`;
            })()}
          </Button>
        </Stack>
        {/* 대량 입력 후 미저장 경고 */}
        {bulkAutoTickets.length > 0 && (
          <Alert severity="info" sx={{ mt: 1 }}>
            📋 대량 입력 {bulkAutoTickets.length}줄이 로컬에 저장됐습니다.
            위 <strong>[💾 {activeTab === 'review' ? '복기' : '이번회차'} 분석·저장]</strong> 버튼을 눌러야 통계에 반영됩니다.
          </Alert>
        )}
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>
          저장 누적
        </Typography>
        <SavedLinesPanel
          currentSlipLines={currentSlipLines}
          slipQueue={slipQueue}
          onRemoveSlip={(idx) =>
            patchManual({ slipQueue: slipQueue.filter((_, i) => i !== idx) })
          }
          onRemoveCurrentLine={removeCurrentLine}
          onEditCurrentLine={editCurrentLine}
          onRemoveSlipLine={removeSlipLine}
        />

        {/* 추가 세팅 — 자동(구입번호 직접입력) 전용. 반자동과 분리. */}
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>
          ⚙ 추가 세팅
        </Typography>
        {(() => {
          // 자동 누적 평탄화 — 반자동 § 3 추가 세팅과 동일 룩앤필.
          // 데이터 소스: 입력 중 줄 + 저장 용지의 모든 줄 + 대량 입력 (bulkAutoTickets).
          // 백엔드 누적은 § 2 IntentAccumulatedPanel 에서만 관리하므로 여기서는 제외.
          const ticketLines = [
            ...currentSlipLines.map((line, idx) => ({
              key: `current-${idx}`,
              label: `입력 중·${line.label}`,
              numbers: line.numbers,
              onRemove: () => removeCurrentLine(idx),
            })),
            ...slipQueue.flatMap((slip, slipIdx) =>
              slip.lines.map((line, lineIdx) => ({
                key: `slip-${slipIdx}-${lineIdx}`,
                label: `용지${slipIdx + 1}·${line.label}`,
                numbers: line.numbers,
                onRemove: () => removeSlipLine(slipIdx, lineIdx),
              }))
            ),
            ...bulkAutoTickets.map((ticket, idx) => ({
              key: `bulk-${idx}`,
              label: `대량 #${idx + 1}`,
              numbers: ticket,
              onRemove: () =>
                patchManual({
                  bulkAutoTickets: bulkAutoTickets.filter((_, i) => i !== idx),
                }),
            })),
          ];
          const winSet = activeTab === 'review' ? activeReviewWinningSet : null;
          return (
            <>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                자동 누적: {slipQueue.length}장 · 입력 중 {currentSlipLines.length}/{GAME_LABELS.length}줄 · 대량 {bulkAutoTickets.length}장 · 총 {ticketLines.length}줄
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                아래 목록의 [×] 로 개별 줄 삭제. 하단 [자동 입력 초기화] 는 현재 탭의 자동 입력 서버 데이터 + 로컬 자동 누적만 삭제합니다. 반자동은 § 3 추가 세팅에서 따로 관리됩니다.
              </Typography>
              {ticketLines.length === 0 ? (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  자동 누적 줄이 없습니다. 위 그리드에서 6개 선택 후 [줄 저장].
                </Alert>
              ) : (
                <Box sx={{ maxHeight: 320, overflowY: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 0.75, mb: 1.5 }}>
                  <Stack spacing={0.5}>
                    {ticketLines.map((line, idx) => {
                      const matchCount = winSet ? line.numbers.filter((n) => winSet.has(n)).length : 0;
                      return (
                        <Stack
                          key={line.key}
                          direction="row"
                          alignItems="center"
                          spacing={0.5}
                          flexWrap="wrap"
                          useFlexGap
                        >
                          <Typography variant="caption" sx={{ minWidth: 36, color: 'text.secondary', fontWeight: 600 }}>
                            #{idx + 1}
                          </Typography>
                          <Chip size="small" label={line.label} variant="outlined" sx={{ minWidth: 84 }} />
                          <Stack direction="row" spacing={0.4} flexWrap="wrap" useFlexGap>
                            {line.numbers.map((n) => (
                              <LottoBall
                                key={`${line.key}-${n}`}
                                number={n}
                                size={22}
                                dimmed={winSet ? !winSet.has(n) : false}
                              />
                            ))}
                          </Stack>
                          {winSet && (
                            <Chip
                              size="small"
                              color={matchCount >= 3 ? 'success' : 'default'}
                              label={`${matchCount}/6`}
                              sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                            />
                          )}
                          <IconButton size="small" onClick={line.onRemove} aria-label="삭제" sx={{ ml: 'auto' }}>
                            ×
                          </IconButton>
                        </Stack>
                      );
                    })}
                  </Stack>
                </Box>
              )}
              <Stack direction="row" justifyContent="flex-end">
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  onClick={clearStore}
                  disabled={
                    ticketLines.length === 0 &&
                    (!accumulated || accumulated.total_analyses === 0)
                  }
                >
                  자동 입력 초기화
                </Button>
              </Stack>
            </>
          );
        })()}
      </Paper>

      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="error" sx={{ whiteSpace: 'pre-wrap' }}>{error}</Alert>}

      {/* ════════════ § 2. 분석 결과 ════════════ */}
      <Divider textAlign="left" sx={{ mt: 1 }}>
        <Typography variant="overline" fontWeight={800} color="primary.main" sx={{ letterSpacing: 1.2 }}>
          § 2. {activeTab === 'review' ? '복기' : '이번회차'} 분석 결과
        </Typography>
      </Divider>

      <NumberFrequencyPanel
        lines={[
          ...currentSlipLines.map((line) => line.numbers),
          ...slipQueue.flatMap((slip) => slip.lines.map((line) => line.numbers)),
          ...bulkAutoTickets,
        ]}
        winningSet={activeTab === 'review' ? activeReviewWinningSet : null}
        sourceLabel="자동 = 구입번호 직접입력"
        bodyLabel="자동 (구입번호 직접입력)"
        emptyHint="자동 데이터가 없습니다. '구입번호 직접입력' 영역에서 줄을 추가하면 여기에 빈도가 표시됩니다."
      />

      <IntentAccumulatedPanel
        slice={activeSlice}
        intent={activeTab}
        legacyCount={accumulated?.legacy_entry_count}
        onDeleteEntry={deleteHistoryEntry}
      />

      <ParallelRoundPanel
        targetRound={activeTab === 'review' ? (latestRound ?? currentRound) : (currentRound ?? latestRound)}
      />

      {/* ════════════ § 3. 비교 · 백테스트 ════════════ */}
      <Divider textAlign="left" sx={{ mt: 1 }}>
        <Typography variant="overline" fontWeight={800} color="primary.main" sx={{ letterSpacing: 1.2 }}>
          § 3. 반자동 비교 · 백테스트
        </Typography>
      </Divider>

      <SemiAutoComparePanel
        sheetIntent={activeTab}
        currentRound={currentRound}
        latestRound={latestRound}
        roundDrawn={roundDrawn}
        slipQueue={slipQueue}
        accumulated={accumulated}
        onAccumulatedChange={setAccumulated}
        onRemoveSlipLine={removeSlipLine}
        currentSlipLines={currentSlipLines}
        bulkAutoTickets={bulkAutoTickets}
        onRemoveCurrentLine={removeCurrentLine}
        onRemoveBulkAutoTicket={(idx) =>
          patchManual({
            bulkAutoTickets: bulkAutoTickets.filter((_, i) => i !== idx),
          })
        }
        onRefreshAccumulated={refreshAccumulated}
      />

      {activeTab === 'review' && <PhotoBacktestPanel accumulated={accumulated} />}

      {/* ════════════ § 4. 고급 설정 ════════════ */}
      <Divider textAlign="left" sx={{ mt: 1 }}>
        <Typography variant="overline" fontWeight={800} color="text.secondary" sx={{ letterSpacing: 1.2 }}>
          § 4. 고급 설정
        </Typography>
      </Divider>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2" color="text.secondary">
            ⚙️ OpenAI Vision 보조 분석 — {visionConfigured ? '사용 중' : '선택 사항'}
          </Typography>
          <Button size="small" onClick={() => setShowVisionAdvanced((v) => !v)}>
            {showVisionAdvanced ? '접기' : '설정'}
          </Button>
        </Stack>
        {showVisionAdvanced && (
          <Stack spacing={1} sx={{ mt: 1.5 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField
                fullWidth
                type="password"
                label="OpenAI API Key (선택)"
                placeholder="sk-..."
                value={visionKey}
                onChange={(e) => setVisionKey(e.target.value)}
              />
              <Button
                variant="outlined"
                disabled={visionSaving || !visionKey.trim().startsWith('sk-')}
                onClick={async () => {
                  setVisionSaving(true);
                  try {
                    const res = await v1Api.savePhotoVisionConfig(visionKey.trim());
                    setVisionConfigured(res.configured);
                    setUseVisionApi(Boolean(res.use_vision_api));
                    setVisionSaveMsg(res.message);
                    setVisionKey('');
                  } catch (e) {
                    setVisionSaveMsg(e instanceof Error ? e.message : '저장 실패');
                  } finally {
                    setVisionSaving(false);
                  }
                }}
              >
                Vision 사용
              </Button>
            </Stack>
            {(visionConfigured || useVisionApi) && (
              <Button
                size="small"
                color="inherit"
                onClick={async () => {
                  try {
                    const res = await v1Api.disablePhotoVisionConfig();
                    setVisionConfigured(res.configured);
                    setUseVisionApi(res.use_vision_api);
                    setVisionSaveMsg(res.message);
                  } catch (e) {
                    setVisionSaveMsg(e instanceof Error ? e.message : '전환 실패');
                  }
                }}
              >
                로컬 분석만 사용
              </Button>
            )}
            {visionSaveMsg && <Alert severity="info" sx={{ mt: 0.5 }}>{visionSaveMsg}</Alert>}
          </Stack>
        )}
      </Paper>

      {/* ════════════ § 5. 분석 이력 (페이지 최하단) ════════════ */}
      {activeSlice?.entries_summary?.length ? (
        <>
          <Divider textAlign="left" sx={{ mt: 1 }}>
            <Typography
              variant="overline"
              fontWeight={800}
              color="text.secondary"
              sx={{ letterSpacing: 1.2 }}
            >
              § 5. {activeTab === 'review' ? '복기' : '이번회차'} 분석 이력
            </Typography>
          </Divider>
          <HistoryEntriesPanel slice={activeSlice} onDeleteEntry={deleteHistoryEntry} />
        </>
      ) : null}

      <BulkLineInputDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={handleBulkInsert}
        linesPerSlip={GAME_LABELS.length}
      />
    </Stack>
  );
}
