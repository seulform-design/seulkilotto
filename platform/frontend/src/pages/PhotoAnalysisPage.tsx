import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
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
import { useCallback, useEffect, useState } from 'react';
import BulkLineInputDialog from '../components/BulkLineInputDialog';
import LottoBall from '../components/LottoBall';
import {
  v1Api,
  type ComboDuplicatePatterns,
  type CrossLineAnalysisReport,
  type DrawReviewTemplate,
  type FrequencyOverlapPatterns,
  type PatternApplication,
  type ManualSlipInput,
  type PhotoAnalysisAccumulated,
  type PhotoAnalysisIntentSlice,
  type PhotoAnalysisResponse,
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

function resolveResultIntent(result: PhotoAnalysisResponse): SheetIntent {
  const intent = result.video_visual_analysis.video_intent ?? result.meta?.sheet_intent;
  return intent === 'review' ? 'review' : 'current_round';
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
      <Typography variant="subtitle1" fontWeight={700} gutterBottom color="text.primary">
        이미지·A~E 줄 교차 분석 (2·3번호 세트)
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={0.5} alignItems="center" sx={{ mb: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          이미지 {data.image_count}장 · 게임 줄 {data.line_count}개 · 2회 이상 공동 출현
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

  const renderCross = (items: ComboDuplicatePatterns['pair_duplicates'], title: string, limit = 15) =>
    items?.length ? (
      <Box>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
          {title}
          {items.length > limit ? ` (상위 ${limit}건)` : ` (${items.length}건)`}
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>번호 조합</TableCell>
              <TableCell>겹친 줄 수</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.slice(0, limit).map((row) => (
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
    ) : null;

  const renderSameLine = () => {
    const matches = data.same_line_matches ?? [];
    if (!matches.length) return null;
    return (
      <Box>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
          {mode === 'review' ? '당첨번호 vs 게임 줄 일치' : '복기 기준번호 vs 게임 줄 일치'} ({matches.length}줄)
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>용지·줄</TableCell>
              <TableCell>일치 번호</TableCell>
              <TableCell>등급</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {matches.slice(0, 20).map((row) => (
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

function PatternApplicationPanel({
  data,
  winningSet,
}: {
  data?: PatternApplication | null;
  winningSet?: Set<number> | null;
}) {
  if (!data?.summary) return null;
  return (
    <Paper sx={{ p: 2, border: '1px solid #1565c0' }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        복기 용지 패턴 → {data.review_round ? `${data.review_round}회 ` : ''}이번회차 용지 적용
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {data.summary}
        {data.review_rounds?.length ? ` (복기 회차: ${data.review_rounds.join(', ')})` : ''}
      </Typography>
      {data.position_match_numbers?.length ? (
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
          <Typography variant="body2" fontWeight={600}>동일 위치:</Typography>
          {data.position_match_numbers.map((n) => (
            <ReviewBall key={n} number={n} size={32} winningSet={winningSet} />
          ))}
        </Stack>
      ) : null}
      {data.combo_hits?.length ? (
        <Stack spacing={0.5}>
          <Typography variant="body2" fontWeight={600}>복기 조합 재출현</Typography>
          {data.combo_hits.slice(0, 8).map((h) => (
            <Typography key={h.numbers.join('-')} variant="body2">
              [{h.numbers.join(', ')}] — 이번 용지 {h.current_sheet_hits}장
            </Typography>
          ))}
        </Stack>
      ) : null}
    </Paper>
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

function FrequencyOverlapPanel({
  data,
  accumulated = false,
  winningSet,
}: {
  data?: FrequencyOverlapPatterns | null;
  accumulated?: boolean;
  winningSet?: Set<number> | null;
}) {
  if (!data?.tiers?.length) return null;
  return (
    <Stack spacing={1.5}>
      {data.tiers.map((tier) => (
        <Box key={tier.min_count}>
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
            {tier.label} ({tier.pattern_type})
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>번호</TableCell>
                <TableCell>{accumulated ? '칸 내 최대 겹침' : '칸 내 겹침'}</TableCell>
                {accumulated && <TableCell>패턴 용지 수</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {tier.items.map((row) => (
                <TableRow key={`${tier.min_count}-${row.number}`}>
                  <TableCell>
                    <ReviewBall number={row.number} size={30} winningSet={winningSet} />
                  </TableCell>
                  <TableCell>{row.max_overlap_count ?? row.overlap_count ?? tier.min_count}회</TableCell>
                  {accumulated && <TableCell>{row.video_votes ?? 1}건</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ))}
    </Stack>
  );
}

function SingleResultPanel({ result }: { result: PhotoAnalysisResponse }) {
  const preview = result.meta?.preview_image_base64;
  const intent = resolveResultIntent(result);
  const winningSet = intent === 'review' ? toWinningSet(result.extracted_visual_patterns.draw_template) : null;
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="body1" sx={{ mb: 1 }}>
          {result.app_ui_message}
        </Typography>
        {result.video_visual_analysis.video_title && (
          <Typography variant="body2" color="text.secondary">
            {result.video_visual_analysis.video_title}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {result.video_visual_analysis.main_board_summary}
        </Typography>
        {result.meta?.vision_error && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            {result.meta.vision_error}
          </Alert>
        )}
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 1 }}>
          {intent === 'review' ? (
            <>
              <Chip label={`복기 · ${result.meta?.review_round_ref ?? result.extracted_visual_patterns.draw_template?.ticket_round}회 당첨`} size="small" color="primary" />
              <Chip label="업로드 용지 vs 당첨번호" size="small" variant="outlined" />
            </>
          ) : (
            <>
              <Chip label={`이번회차 · ${result.meta?.current_round_ref ?? result.video_visual_analysis.ticket_round}회`} size="small" color="secondary" />
              <Chip label="저장된 복기 용지 패턴 적용" size="small" variant="outlined" />
            </>
          )}
          {result.meta?.analysis_mode && (
            <Chip
              label={`엔진: ${
                result.meta.analysis_mode === 'vision'
                  ? 'Vision+로컬'
                  : result.meta.analysis_mode === 'local' || result.meta.analysis_mode === 'opencv'
                    ? '로컬(OpenCV)'
                    : result.meta.analysis_mode
              }`}
              size="small"
              variant="outlined"
            />
          )}
          {(result.meta?.duplicates_removed ?? 0) > 0 && (
            <Chip
              label={`중복 제거 ${result.meta!.duplicates_removed}장`}
              size="small"
              color="warning"
              variant="outlined"
            />
          )}
        </Stack>
      </Paper>
      {preview && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>
            분석 대표 사진
          </Typography>
          <Box
            component="img"
            src={`data:image/jpeg;base64,${preview}`}
            alt="분석 사진"
            sx={{ maxWidth: '100%', borderRadius: 1, border: '1px solid #333' }}
          />
        </Paper>
      )}
      {intent === 'review' && (
        <DrawWinningTemplatePanel
          data={result.extracted_visual_patterns.draw_template}
          intentLabel="복기"
        />
      )}
      {intent === 'current_round' && (
        <SavedReviewTemplatePanel
          data={
            result.extracted_visual_patterns.review_reference_template
            || result.extracted_visual_patterns.photo_review_template
          }
        />
      )}
      {result.extracted_visual_patterns.combo_patterns?.cross_line_analysis && (
        <CrossLineAnalysisPanel
          data={result.extracted_visual_patterns.combo_patterns.cross_line_analysis}
          winningSet={winningSet}
        />
      )}
      {result.extracted_visual_patterns.combo_patterns && (
        <Paper sx={{ p: 2, border: '1px solid #5c4d00' }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            {intent === 'review'
              ? `복기 — ${result.meta?.review_round_ref ?? '1226'}회 당첨번호 · 게임 줄 일치`
              : '이번회차 — 게임 줄 겹침 (기준번호 일치 + 줄간 조합)'}
          </Typography>
          <ComboDuplicatePanel
            data={result.extracted_visual_patterns.combo_patterns}
            mode={intent}
            winningSet={winningSet}
          />
        </Paper>
      )}
      {intent === 'current_round' && (
        <PatternApplicationPanel data={result.extracted_visual_patterns.pattern_application} />
      )}
      {intent === 'review' && result.extracted_visual_patterns.draw_analysis && (
        <Paper sx={{ p: 2, border: '1px solid #1565c0' }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            복기 — 당첨번호 위치·조합 일치
          </Typography>
          <PatternApplicationPanel data={result.extracted_visual_patterns.draw_analysis} winningSet={winningSet} />
        </Paper>
      )}
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          추천 후보
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {result.final_predictions.strong_candidates.map((n) => (
            <ReviewBall key={n} number={n} size={40} winningSet={winningSet} />
          ))}
        </Stack>
      </Paper>
    </Stack>
  );
}

type SelectedFile = { id: string; file: File };

function fileKey(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

function mergeUniqueFiles(existing: SelectedFile[], incoming: File[]): SelectedFile[] {
  const seen = new Set(existing.map((x) => fileKey(x.file)));
  const out = [...existing];
  for (const f of incoming) {
    const k = fileKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: `${k}-${Math.random().toString(36).slice(2, 8)}`, file: f });
    if (out.length >= 50) break;
  }
  return out;
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
          ? '복기 탭에 저장된 분석이 없습니다. 당첨번호 검증용 사진을 업로드해 분석하세요.'
          : '이번회차 탭에 저장된 분석이 없습니다. 복기 분석 후 이번회차 용지를 분석하세요.'}
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
      {intent === 'current_round' && (
        <>
          <SavedReviewTemplatePanel data={slice.saved_review_template} />
          {slice.pattern_ready === false && (
            <Alert severity="warning">복기 탭에서 사진 분석을 먼저 완료해야 이번회차 패턴이 적용됩니다.</Alert>
          )}
        </>
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
      {slice.entries_summary?.length ? (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            {slice.video_intent_label} 분석 이력
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
                  <TableCell>{e.analyzed_at?.slice(0, 16).replace('T', ' ')}</TableCell>
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
      ) : null}
    </Stack>
  );
}

const GAME_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
type GameLabel = (typeof GAME_LABELS)[number];
const GRID_NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);
const GRID_COLS = 7;

type SavedLine = { label: GameLabel; numbers: number[] };

function slipFromLines(lines: SavedLine[]): ManualSlipInput {
  return {
    lines: lines.map((line) => ({
      label: line.label,
      numbers: [...line.numbers].sort((a, b) => a - b),
    })),
  };
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
            <LottoBall key={n} number={n} size={32} />
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
              <LottoBall number={n} size={36} dimmed={!selected} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function SavedLinesPanel({
  currentSlipLines,
  slipQueue,
  onRemoveSlip,
  onRemoveCurrentLine,
  onEditCurrentLine,
  onRemoveSlipLine,
}: {
  currentSlipLines: SavedLine[];
  slipQueue: ManualSlipInput[];
  onRemoveSlip: (index: number) => void;
  onRemoveCurrentLine: (index: number) => void;
  onEditCurrentLine: (index: number) => void;
  onRemoveSlipLine: (slipIndex: number, lineIndex: number) => void;
}) {
  const totalLines =
    currentSlipLines.length + slipQueue.reduce((sum, slip) => sum + slip.lines.length, 0);
  if (!totalLines) {
    return (
      <Typography variant="body2" color="text.secondary">
        저장된 줄이 없습니다. 번호 6개 선택 후 「줄 저장」을 누르세요.
      </Typography>
    );
  }
  return (
    <Stack spacing={1.5}>
      {currentSlipLines.length > 0 && (
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            입력 중 (용지 {slipQueue.length + 1} · {currentSlipLines.length}/5줄)
          </Typography>
          {currentSlipLines.map((line, idx) => (
            <Stack
              key={`current-${idx}`}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ mb: 0.5 }}
            >
              <Chip label={line.label} size="small" color="primary" variant="outlined" />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {line.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
              <Button
                size="small"
                variant="text"
                onClick={() => onEditCurrentLine(idx)}
                sx={{ minWidth: 'auto', px: 1 }}
                aria-label={`${line.label}줄 수정`}
              >
                수정
              </Button>
              <IconButton
                size="small"
                onClick={() => onRemoveCurrentLine(idx)}
                aria-label={`${line.label}줄 삭제`}
              >
                ×
              </IconButton>
            </Stack>
          ))}
        </Box>
      )}
      {slipQueue.map((slip, slipIdx) => (
        <Box key={`slip-${slipIdx}`}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 0.5 }}
          >
            <Typography variant="caption" color="text.secondary">
              용지 {slipIdx + 1} (저장됨 · {slip.lines.length}줄)
            </Typography>
            <IconButton
              size="small"
              onClick={() => onRemoveSlip(slipIdx)}
              aria-label={`용지 ${slipIdx + 1} 전체 삭제`}
            >
              ×
            </IconButton>
          </Stack>
          {slip.lines.map((line, lineIdx) => (
            <Stack
              key={`${slipIdx}-${lineIdx}`}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ mb: 0.5 }}
            >
              <Chip label={line.label} size="small" variant="outlined" />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {line.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={28} />
                ))}
              </Stack>
              <IconButton
                size="small"
                onClick={() => onRemoveSlipLine(slipIdx, lineIdx)}
                aria-label={`용지 ${slipIdx + 1} ${line.label}줄 삭제`}
              >
                ×
              </IconButton>
            </Stack>
          ))}
        </Box>
      ))}
    </Stack>
  );
}

const emptySelected = (): Record<SheetIntent, SelectedFile[]> => ({ review: [], current_round: [] });

export default function PhotoAnalysisPage() {
  const [activeTab, setActiveTab] = useState<SheetIntent>('review');
  const [selectedByIntent, setSelectedByIntent] = useState<Record<SheetIntent, SelectedFile[]>>(emptySelected);
  const emptyManualDraft = () => ({
    picked: [] as number[],
    currentSlipLines: [] as SavedLine[],
    slipQueue: [] as ManualSlipInput[],
  });
  const [manualByIntent, setManualByIntent] = useState<Record<SheetIntent, ReturnType<typeof emptyManualDraft>>>({
    review: emptyManualDraft(),
    current_round: emptyManualDraft(),
  });
  const [showPhotoUpload, setShowPhotoUpload] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resultsByIntent, setResultsByIntent] = useState<Partial<Record<SheetIntent, PhotoAnalysisResponse>>>({});
  const [accumulated, setAccumulated] = useState<PhotoAnalysisAccumulated | null>(null);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [useVisionApi, setUseVisionApi] = useState(false);
  const [showVisionAdvanced, setShowVisionAdvanced] = useState(false);
  const [visionKey, setVisionKey] = useState('');
  const [visionSaving, setVisionSaving] = useState(false);
  const [visionSaveMsg, setVisionSaveMsg] = useState<string | null>(null);
  const [latestRound, setLatestRound] = useState<number | null>(null);
  const [currentRound, setCurrentRound] = useState<number | null>(null);

  const refreshAccumulated = useCallback(async () => {
    try {
      setAccumulated(await v1Api.getPhotoAnalysisAccumulated());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshAccumulated();
    v1Api.getMeta().then((m) => {
      setLatestRound(m.latest_round);
      setCurrentRound(m.current_round);
    }).catch(() => {});
    v1Api
      .getPhotoVisionConfig()
      .then((c) => {
        setVisionConfigured(c.configured);
        setUseVisionApi(Boolean(c.use_vision_api));
      })
      .catch(() => {
        setVisionConfigured(false);
        setUseVisionApi(false);
      });
  }, [refreshAccumulated]);

  const selected = selectedByIntent[activeTab];
  const activeResult = resultsByIntent[activeTab] ?? null;
  const activeSlice = accumulated?.by_intent?.[activeTab] ?? null;
  const manualDraft = manualByIntent[activeTab];
  const { picked, currentSlipLines, slipQueue } = manualDraft;

  const patchManual = (patch: Partial<ReturnType<typeof emptyManualDraft>>) => {
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
    const line: SavedLine = { label: currentLabel, numbers: [...picked].sort((a, b) => a - b) };
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
   * 대량 입력 처리.
   *
   * 받은 6-튜플 배열을 5줄씩 슬립으로 묶어 slipQueue 에 append.
   * 현재 진행 중인 currentSlipLines / picked 는 보존 — 사용자 작업 보호.
   * 마지막 슬립이 5줄 미만이면 부분 슬립으로 추가됨 (백엔드가 허용).
   */
  const handleBulkInsert = (lines: number[][]) => {
    if (!lines.length) return;
    const newSlips: ManualSlipInput[] = [];
    for (let i = 0; i < lines.length; i += GAME_LABELS.length) {
      const chunk = lines.slice(i, i + GAME_LABELS.length);
      const slipLines: SavedLine[] = chunk.map((numbers, idx) => ({
        label: GAME_LABELS[idx],
        numbers: [...numbers].sort((a, b) => a - b),
      }));
      newSlips.push(slipFromLines(slipLines));
    }
    patchManual({ slipQueue: [...slipQueue, ...newSlips] });
    setError(null);
    setNotice(
      `${lines.length}줄 → ${newSlips.length}장 추가 완료 (총 ${slipQueue.length + newSlips.length}장 누적)`
    );
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
    if (!slips.length) {
      setError('저장된 줄이 없습니다. 번호 6개 선택 후 「줄 저장」을 누르세요.');
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await v1Api.analyzeManualSlips(slips, { sheetIntent: activeTab, persist: true });
      if (data.result) {
        const intent = resolveResultIntent(data.result);
        setResultsByIntent((prev) => ({ ...prev, [intent]: data.result! }));
      }
      if (data.accumulated) setAccumulated(data.accumulated);
      if (data.duplicate_skipped) {
        setError(data.duplicate_message || '이미 등록된 용지입니다.');
      } else {
        patchManual({ slipQueue: [], currentSlipLines: [], picked: [] });
        setNotice(`${slips.length}장 분석·저장 완료`);
      }
      await refreshAccumulated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '분석 실패');
    } finally {
      setLoading(false);
    }
  };

  const runAnalyze = async () => {
    if (!selected.length) {
      setError('사진을 1장 이상 첨부하세요.');
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await v1Api.analyzePhotos(
        selected.map((s) => s.file),
        { sheetIntent: activeTab, persist: true }
      );
      if (data.result) {
        const intent = resolveResultIntent(data.result);
        setResultsByIntent((prev) => ({ ...prev, [intent]: data.result! }));
      }
      if (data.accumulated) setAccumulated(data.accumulated);
      const dupMsg =
        (data.duplicates_removed ?? 0) > 0
          ? `동일 사진 ${data.duplicates_removed}장 자동 제외됨.`
          : null;
      if (data.duplicate_skipped) {
        setError(data.duplicate_message || '이미 분석된 사진 세트입니다.');
        if (dupMsg) setNotice(dupMsg);
      } else {
        setSelectedByIntent((prev) => ({ ...prev, [activeTab]: [] }));
        if (dupMsg) setNotice(dupMsg);
      }
      await refreshAccumulated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '분석 실패');
    } finally {
      setLoading(false);
    }
  };

  const removeSelected = (id: string) => {
    setSelectedByIntent((prev) => ({
      ...prev,
      [activeTab]: prev[activeTab].filter((s) => s.id !== id),
    }));
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
    if (!window.confirm('누적된 모든 사진 분석 데이터를 삭제할까요?')) return;
    try {
      await v1Api.clearPhotoAnalysisStore();
      setAccumulated(null);
      setResultsByIntent({});
      setSelectedByIntent(emptySelected());
      setManualByIntent({ review: emptyManualDraft(), current_round: emptyManualDraft() });
      await refreshAccumulated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5" fontWeight={800}>
          자동번호 용지 분석 (수기 등록)
        </Typography>
        {accumulated && accumulated.total_analyses > 0 && (
          <Button size="small" color="error" variant="outlined" onClick={clearStore}>
            누적 삭제
          </Button>
        )}
      </Stack>

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
            label={`복기 (${latestRound ?? '1226'}회 당첨)`}
            sx={{ fontWeight: activeTab === 'review' ? 700 : 400 }}
          />
          <Tab
            value="current_round"
            label={`이번회차 (${currentRound ?? '1227'}회)`}
            sx={{ fontWeight: activeTab === 'current_round' ? 700 : 400 }}
          />
        </Tabs>
      </Paper>

      <Alert severity="info">
        {activeTab === 'review' ? (
          <>
            <strong>복기 탭</strong> — {latestRound ?? '1226'}회 <strong>당첨번호</strong>와 수기 등록한 <strong>A~E 줄(각 6번호)</strong> 일치를 확인합니다.
            A/B/C/D/E 다른 줄에도 겹치는 번호 조합을 함께 표시합니다.
          </>
        ) : (
          <>
            <strong>이번회차 탭</strong> — {currentRound ?? '1227'}회 수기 등록 <strong>A~E 줄</strong>이 복기 기준과 맞는지, <strong>다른 줄·다른 용지</strong> 겹치는 2·3·4번호를 검사합니다.
          </>
        )}
      </Alert>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2" color="text.secondary">
            {visionConfigured
              ? 'OpenAI Vision 보조 분석 사용 중 (선택)'
              : 'OpenAI Vision은 선택 사항입니다'}
          </Typography>
          <Button size="small" onClick={() => setShowVisionAdvanced((v) => !v)}>
            {showVisionAdvanced ? '접기' : '고급 설정'}
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

      <Alert severity="info">
        번호를 눌러 6개 선택 → <strong>줄 저장</strong> (A→B→C→D→E). 5줄이 모이면 용지 1장이 누적됩니다.
        여러 장 저장 후 <strong>분석·저장</strong>을 누르세요.
      </Alert>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            구입번호 직접입력
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={resetPicked}>
              초기화
            </Button>
            <Button size="small" variant="contained" onClick={saveCurrentLine} disabled={picked.length !== 6}>
              줄 저장
            </Button>
          </Stack>
        </Stack>
        <ManualNumberGrid picked={picked} onToggle={togglePicked} currentLabel={currentLabel} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }}>
          <Button variant="outlined" color="inherit" onClick={resetCurrentSlip}>
            용지 초기화
          </Button>
          <Button variant="outlined" color="primary" onClick={() => setBulkOpen(true)}>
            ⬆ 대량 입력 (텍스트)
          </Button>
          <Button variant="contained" onClick={runManualAnalyze} disabled={loading}>
            {loading ? (
              <CircularProgress size={22} color="inherit" />
            ) : activeTab === 'review' ? (
              `복기 분석 · 저장 (${slipQueue.length}장)`
            ) : (
              `이번회차 분석 · 저장 (${slipQueue.length}장)`
            )}
          </Button>
        </Stack>
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
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: showPhotoUpload ? 1.5 : 0 }}>
          <Typography variant="body2" color="text.secondary">
            사진 업로드 (선택 · OCR)
          </Typography>
          <Button size="small" onClick={() => setShowPhotoUpload((v) => !v)}>
            {showPhotoUpload ? '접기' : '펼치기'}
          </Button>
        </Stack>
        {showPhotoUpload && (
        <Stack spacing={1.5}>
          <Button variant="outlined" component="label">
            사진 선택 (jpg, png, webp)
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/bmp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                const picked = Array.from(e.target.files || []);
                setSelectedByIntent((prev) => ({
                  ...prev,
                  [activeTab]: mergeUniqueFiles(prev[activeTab], picked),
                }));
                e.target.value = '';
              }}
            />
          </Button>
          {selected.length > 0 && (
            <Stack spacing={0.5}>
              <Typography variant="body2" color="text.secondary">
                {selected.length}장 선택 (최대 50장) — X로 개별 제거
              </Typography>
              <Stack spacing={0.5} sx={{ maxHeight: 200, overflow: 'auto' }}>
                {selected.map((s) => (
                  <Stack key={s.id} direction="row" alignItems="center" spacing={1}>
                    <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                      {s.file.name}
                    </Typography>
                    <IconButton size="small" onClick={() => removeSelected(s.id)} aria-label="제거">
                      ×
                    </IconButton>
                  </Stack>
                ))}
              </Stack>
            </Stack>
          )}
          <Button variant="outlined" onClick={runAnalyze} disabled={loading || !selected.length}>
            {loading ? <CircularProgress size={22} color="inherit" /> : '사진으로 분석 · 저장'}
          </Button>
        </Stack>
        )}
      </Paper>

      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="error" sx={{ whiteSpace: 'pre-wrap' }}>{error}</Alert>}
      <Divider />
      <Typography variant="h6" fontWeight={700}>
        {activeTab === 'review' ? '복기' : '이번회차'} 누적
      </Typography>
      <IntentAccumulatedPanel
        slice={activeSlice}
        intent={activeTab}
        legacyCount={accumulated?.legacy_entry_count}
        onDeleteEntry={deleteHistoryEntry}
      />
      {activeResult && (
        <>
          <Divider />
          <Typography variant="h6" fontWeight={700}>
            {activeTab === 'review' ? '복기' : '이번회차'} 최근 분석
          </Typography>
          <SingleResultPanel result={activeResult} />
        </>
      )}

      <BulkLineInputDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={handleBulkInsert}
        linesPerSlip={GAME_LABELS.length}
      />
    </Stack>
  );
}
