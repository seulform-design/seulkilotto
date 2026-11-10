/**
 * 자동 수집·공식 검증 파이프라인 상태 — 실제 /api/v1/pipeline/* 응답만 표시(샘플 데이터 없음).
 * 모바일(320~430px)에서 줄바꿈되는 칩·카드 레이아웃, 가로 스크롤 없음.
 */
import { Alert, Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'error' | 'default' | 'info'> = {
  완료: 'success',
  '학습 중': 'info',
  '데이터 부족': 'warning',
  실패: 'error',
  대기: 'default',
  '재검증 필요': 'warning',
};

function fmt(ts?: string | null) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('ko-KR', { hour12: false });
  } catch {
    return ts;
  }
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 700 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export default function PipelineStatusPanel() {
  const [open, setOpen] = useState(true);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const st = useQuery({ queryKey: ['v1-pipeline-status'], queryFn: v1Api.getPipelineStatus, refetchInterval: 60_000 });
  const cal = useQuery({ queryKey: ['v1-coselection-cal'], queryFn: v1Api.getCoselectionCalibration, staleTime: 3_600_000, enabled: open });
  const tk = useQuery({ queryKey: ['v1-ticket-analysis'], queryFn: v1Api.getTicketAnalysis, staleTime: 600_000, enabled: open });
  const sd = useQuery({ queryKey: ['v1-seed-dashboard'], queryFn: v1Api.getSeedDashboard, staleTime: 300_000, enabled: open });
  const yt = useQuery({ queryKey: ['v1-yt-api-check'], queryFn: v1Api.getYoutubeApiCheck, staleTime: 3_600_000, enabled: open });
  const cov = useQuery({ queryKey: ['v1-yt-coverage'], queryFn: v1Api.getYoutubeCoverage, staleTime: 300_000, enabled: open });
  const d = st.data;
  const reg = d?.registry ?? {};
  const jobs = (d?.jobs ?? {}) as Record<string, any>;
  const engines = (d?.engines ?? []) as any[];
  const learning = engines.filter((e) => e.category === 'sheet_dependent');
  const statsEng = engines.filter((e) => e.category === 'draw_data');
  const allErrors = (d?.recent_errors ?? []) as any[];
  const errors = allErrors.filter((e) => !e.resolved);
  const resolvedErrors = allErrors.filter((e) => e.resolved);
  const sync = jobs.sync_rounds;
  const verified = reg.draws_by_status?.official_verified ?? 0;
  const legacy = reg.draws_by_status?.legacy_unverified ?? 0;
  const staging = Object.entries((reg.staging_open ?? {}) as Record<string, number>);

  const run = async () => {
    setRunMsg('요청 중…');
    try {
      const r = await v1Api.runPipeline();
      setRunMsg(r.started ? '백그라운드 실행을 시작했습니다. 1~2분 뒤 새로고침 됩니다.' : `실행 안 됨: ${r.reason ?? ''}`);
      setTimeout(() => st.refetch(), 60_000);
    } catch (e: any) {
      setRunMsg(String(e?.message ?? e).includes('401') ? '관리 키가 필요한 작업입니다(서버 설정).' : `실패: ${e?.message ?? e}`);
    }
  };

  return (
    <EngineSection
      tone="success"
      title="🛰️ 자동 수집 · 공식 검증 파이프라인"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      chips={
        d ? (
          <EngineStatusChip
            color={errors.length ? 'warning' : 'success'}
            label={`검증 ${reg.latest_verified_round ?? '—'}회 · 오류 ${errors.length}`}
          />
        ) : undefined
      }
      intent={
        <>
          유튜브(공식 채널·결과 채널 RSS)로 새 회차 영상을 찾고, <strong>동행복권 공식 결과와 번호·보너스·추첨일이 모두 일치할 때만</strong>{' '}
          정식 DB에 저장합니다. 새 회차가 들어오면 통계·백테스트·학습 엔진이 자동 갱신됩니다.
        </>
      }
    >
      {st.isLoading && <LinearProgress />}
      {st.isError && <Alert severity="warning">파이프라인 상태를 불러오지 못했습니다.</Alert>}
      {d && (
        <Stack spacing={1.25}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1 }}>
            <Card title="최신 회차(공식 검증)">
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{reg.latest_verified_round ?? '—'}회</Typography>
              <Typography variant="caption" color="text.secondary">검증 {fmt(reg.latest_verified_at)}</Typography>
            </Card>
            <Card title="마지막 수집">
              <Typography variant="body2">{fmt(sync?.finished_at ?? sync?.started_at)}</Typography>
              <Typography variant="caption" color={sync?.status === 'failed' ? 'error.main' : 'text.secondary'}>
                {sync ? `${sync.status} · 시도 ${sync.attempt}` : '아직 실행 전'}
              </Typography>
            </Card>
            <Card title="공식 검증 상태">
              <Typography variant="body2">검증 {verified}회 · 미대조 {legacy}회</Typography>
              <Typography variant="caption" color={staging.length ? 'warning.main' : 'text.secondary'}>
                {staging.length ? staging.map(([k, v]) => `${k} ${v}`).join(' · ') : '검토 대기 없음'}
              </Typography>
            </Card>
            <Card title="DB">
              <Typography variant="body2">{d.storage?.backend === 'postgres' ? 'Postgres(영구)' : 'SQLite'}</Typography>
              <Typography variant="caption" color="text.secondary">
                유튜브 영상 {reg.youtube_videos ?? 0}개 · {fmt(reg.youtube_last_collected_at)}
              </Typography>
            </Card>
          </Box>

          <Box>
            <Typography variant="caption" sx={{ fontWeight: 700 }}>학습 엔진 6종 (입력: {d.ticket_learning_source?.mode === 'manual' ? '수동 보관 용지' : d.ticket_learning_source?.mode === 'both' ? '유튜브+수동 용지' : '유튜브 확정 용지'} + 당첨번호
              {d.ticket_learning_source?.youtube ? ` · 유튜브 ${d.ticket_learning_source.youtube.rounds.length}개 회차 자동 ${d.ticket_learning_source.youtube.auto_lines}줄·반자동 ${d.ticket_learning_source.youtube.semi_lines}줄` : ''})</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 0.5 }}>
              {learning.length === 0 && <Typography variant="caption" color="text.secondary">아직 실행 전</Typography>}
              {learning.map((e) => (
                <Chip
                  key={e.engine}
                  size="small"
                  color={STATUS_COLOR[e.status] ?? 'default'}
                  variant="outlined"
                  label={`${e.label}: ${e.status}${e.summary?.samples != null ? ` (표본 ${e.summary.samples})` : ''}`}
                  title={`마지막 실행 ${fmt(e.last_run_at)}${e.error ? ` · 오류: ${e.error}` : ''}`}
                />
              ))}
            </Stack>
            {learning[0] && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                마지막 학습 {fmt(learning.map((e) => e.last_run_at).filter(Boolean).sort().pop())} · 같은 입력이면 재학습하지 않습니다(학습 횟수 ≠ 예측력).
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="caption" sx={{ fontWeight: 700 }}>통계·백테스트 자동 갱신</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 0.5 }}>
              {statsEng.map((e) => (
                <Chip
                  key={e.engine}
                  size="small"
                  color={STATUS_COLOR[e.status] ?? 'default'}
                  variant="outlined"
                  label={`${e.label}: ${e.status} · ${fmt(e.last_run_at)}`}
                />
              ))}
              {d.backtest_log?.strategies?.length > 0 && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`예측 기록 ${d.backtest_log.strategies[0].rounds}회 × ${d.backtest_log.strategies.length}전략 · 갱신 ${fmt(d.backtest_log.strategies[0].updated_at)}`}
                />
              )}
            </Stack>
          </Box>

          {resolvedErrors.length > 0 && (
            <Typography variant="caption" color="text.secondary" component="div">
              해결된 과거 오류 {resolvedErrors.length}건(이후 같은 작업 성공): {resolvedErrors.slice(0, 3).map((e) => `${e.name}·${e.error_kind}`).join(', ')}
            </Typography>
          )}

          {errors.length > 0 && (
            <Alert severity="warning" sx={{ py: 0.25 }}>
              <Typography variant="caption" component="div" sx={{ fontWeight: 700 }}>최근 오류 · 재시도</Typography>
              {errors.slice(0, 4).map((e, i) => (
                <Typography key={i} variant="caption" component="div" sx={{ wordBreak: 'break-all' }}>
                  {fmt(e.started_at)} · {e.name} · {e.error_kind} · 시도 {e.attempt} — {String(e.error ?? '').slice(0, 120)}
                </Typography>
              ))}
            </Alert>
          )}

          {cal.data && (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
                공동선택 회피 점수 실측 검증 {cal.data.ok ? `(${cal.data.rounds}회차, 신뢰도 ${cal.data.confidence})` : '(데이터 수집 전)'}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {cal.data.ok
                  ? `${cal.data.interpretation} 3등(5개 일치) 인기도 순위상관 ρ=${cal.data.spearman_risk_vs_rank3_popularity?.rho} · 1등 ρ=${cal.data.spearman_risk_vs_jackpot_popularity?.rho}`
                  : cal.data.reason}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                출처: {cal.data.data_source ?? '—'} · 1등 확률(1/8,145,060)과 무관한 기대수령액 지표입니다.
              </Typography>
            </Box>
          )}

          {tk.data && (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
                유튜브 용지 데이터(공개 썸네일 OCR · 자동/반자동 분리)
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                자동 {tk.data.analysis?.by_type?.auto?.accepted_lines ?? 0}줄 · 반자동 {tk.data.analysis?.by_type?.semi_auto?.accepted_lines ?? 0}줄 승인 ·
                상태 {Object.entries((tk.data.analysis?.status_counts ?? {}) as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(', ') || '없음'}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {tk.data.analysis?.by_type?.auto?.sample_note} 바코드·QR·TR 번호·이미지는 저장하지 않습니다.
              </Typography>
            </Box>
          )}

          {sd.data && (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
                기준 영상 기반 용지 수집 {sd.data.seeds?.[0] ? `· ${sd.data.seeds[0].channel} “${String(sd.data.seeds[0].title ?? '').trim()}” (${sd.data.seeds[0].status})` : '· 기준 영상 미등록'}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 0.5, mt: 0.5 }}>
                {[
                  ['수집 영상', sd.data.discovered_total],
                  ['유사(용지) 영상', sd.data.similar_found],
                  ['중복 제거', sd.data.duplicates_removed],
                  ['용지 탐지', `${sd.data.frames_with_ticket}/${sd.data.frames_total}`],
                  ['자동 확정', sd.data.auto?.accepted ?? 0],
                  ['자동 검토대기', sd.data.auto?.pending_review ?? 0],
                  ['반자동 확정', sd.data.semi_auto?.accepted ?? 0],
                  ['학습 제외', sd.data.excluded],
                  ['회차 미확정', sd.data.round_unconfirmed],
                  ['OCR 오류', sd.data.ocr_errors],
                ].map(([k, v]) => (
                  <Box key={String(k)} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 0.75, py: 0.25 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>{k}</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{String(v ?? 0)}</Typography>
                  </Box>
                ))}
              </Box>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                6종 엔진 반영: {Object.entries((sd.data.learning_link ?? {}) as Record<string, string>)
                  .map(([k, v]) => `${k} ${v === 'connected' ? '연결' : '보관용지 전용'}`).join(' · ')}
                {sd.data.channel_concentration?.top_share != null && ` · 최다 채널 비중 ${Math.round(sd.data.channel_concentration.top_share * 100)}%(편중 주의)`}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {sd.data.access_policy} 영상에 보인 용지는 관찰 데이터이며 구매 완료로 간주하지 않습니다.
              </Typography>
            </Box>
          )}

          {cov.data && (
            <Box sx={{ border: 1, borderColor: cov.data.api?.key_status?.primary_present ? 'divider' : 'warning.main', borderRadius: 1.5, p: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
                전 회차 YouTube 검색 · API {cov.data.api?.key_status?.primary_present ? '키 설정됨' : '키 미설정 — 검색 중지(RSS·썸네일만)'}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                회차 {cov.data.rounds?.total ?? 0}개 중 검색함 {cov.data.rounds?.searched_any ?? 0} · 대기 {cov.data.rounds?.pending ?? 0} ·
                영상 발견 회차 {cov.data.rounds?.with_videos ?? 0} · 검색했지만 영상 없음 {cov.data.rounds?.without_videos_after_search ?? 0}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                고유 영상 {cov.data.videos?.unique ?? 0} · 채널 {cov.data.channels?.total ?? 0} · 판독 대기 {cov.data.videos?.queued_for_ticket_ocr ?? 0} ·
                판독 완료 {cov.data.videos?.ocr_processed ?? 0} · 접근 불가 {cov.data.videos?.unavailable ?? 0}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                할당량 {cov.data.api?.quota_used_today ?? 0}/{cov.data.api?.quota_budget ?? 0} units · 마지막 정상 호출 {fmt(cov.data.api?.last_ok_call)} ·
                마지막 오류 {cov.data.api?.last_error ? `${cov.data.api.last_error.error_code} (HTTP ${cov.data.api.last_error.http ?? '-'})` : '없음'}
                {cov.data.estimated_days_remaining ? ` · 남은 검색 약 ${cov.data.estimated_days_remaining}일` : ''}
              </Typography>
            </Box>
          )}

          {yt.data && (
            <Typography variant="caption" color={yt.data.status === 'ok' ? 'success.main' : 'text.secondary'}>
              YouTube Data API: {yt.data.status === 'ok' ? '정상' : yt.data.status === 'missing_key' ? '키 미설정(RSS·oEmbed·공개 썸네일만 사용, 과거 영상 전체 검색 불가)' : `오류 ${yt.data.status}${yt.data.http ? ` (HTTP ${yt.data.http})` : ''}`}
            </Typography>
          )}

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button size="small" variant="outlined" onClick={() => st.refetch()}>상태 새로고침</Button>
            <Button size="small" variant="outlined" onClick={run}>지금 수집·검증 실행</Button>
            {runMsg && <Typography variant="caption">{runMsg}</Typography>}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            모바일 화면은 브라우저 폭 320·375·430px 에뮬레이션으로 확인했으며 실제 기기에서는 미검증입니다.
          </Typography>
        </Stack>
      )}
    </EngineSection>
  );
}
