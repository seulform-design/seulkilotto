/**
 * 🔬 분석 엔진 — 용지 입력 폐지(2026-11-07) 때 화면에서 떨어져 나간 기존 분석 엔진들을
 * 원래 컴포넌트·API 그대로 다시 연결한 탭(2026-11-10 복구).
 *
 *  1. 데이터·기준값       : 무결성 + 수학적 확률(신규 stats_engine)
 *  2. 회차 통계           : 표본 크기별 통계(신규) — 빈도/온도/동반/분포는 '회차' 탭 심층 통계에 그대로 있음
 *  3. 추천 엔진(기존)     : 추첨기 엔진 · 호기 개요 · 평행회차 · 후속출현
 *  4. 검증·백테스트(기존+신규) : 전체 이력 백테스트 · 6개 1장 백테스트 · 전략 walk-forward
 *  5. 보관 용지 학습 엔진(기존) : 과거 보관된 용지 데이터 기반 — 펼칠 때만 계산(무거움)
 *
 * 모든 패널은 실제 백엔드 API 를 호출한다(정적 샘플 없음).
 */
import { Alert, Button, Chip, Stack, Typography } from '@mui/material';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { IntegrityProbabilityPanel, TicketBacktestPanel, WindowStatsPanel } from '../components/StatsEnginePanels';
import FullHistoryBacktestPanel from '../components/FullHistoryBacktestPanel';
import WalkForwardPanel from '../components/WalkForwardPanel';
import ParallelRoundPanel from '../components/ParallelRoundPanel';
import MachineOverviewPanel from '../components/MachineOverviewPanel';
import PipelineStatusPanel from '../components/PipelineStatusPanel';
import RoundPredictionPanel from '../components/RoundPredictionPanel';
import EngineAuditPanel from '../components/EngineAuditPanel';
import ReverseAnalysisPanel from '../components/ReverseAnalysisPanel';
import MasterEnginePanel from '../components/MasterEnginePanel';
import RoundAuditPanel from '../components/RoundAuditPanel';
import PatternAtlasPanel from '../components/PatternAtlasPanel';

const RoundRecommendPage = lazy(() => import('./RoundRecommendPage'));
const PostOccurrencePage = lazy(() => import('./PostOccurrencePage'));
const FeatureLearningPanel = lazy(() => import('../components/FeatureLearningPanel'));
const NestedCvPanel = lazy(() => import('../components/NestedCvPanel'));
const ShapDriftPanel = lazy(() => import('../components/ShapDriftPanel'));
const PatternMiningPanel = lazy(() => import('../components/PatternMiningPanel'));
const RoundLearningPanel = lazy(() => import('../components/RoundLearningPanel'));
const OverlapLearningServerPanel = lazy(() => import('../components/OverlapLearningServerPanel'));

function Group({ id, title, note, children }: { id?: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <Stack spacing={1.25} id={id} sx={{ scrollMarginTop: 72 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>{title}</Typography>
      {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
      {children}
    </Stack>
  );
}

/** 열 때만 마운트(무거운 엔진이 탭 진입만으로 계산되지 않게). */
function MountOnOpen({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <Suspense fallback={<Typography variant="caption">불러오는 중…</Typography>}>{children}</Suspense>
  ) : (
    <Button
      variant="outlined"
      size="small"
      onClick={() => setOpen(true)}
      sx={{ alignSelf: 'flex-start', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', textTransform: 'none' }}
    >
      {label}
    </Button>
  );
}

// 화면 묶음(2026-11-14 정리): 같은 주제(엔진 성적·중복 번호)가 여러 묶음에 흩어져 중복처럼 보이던 것을 주제별로 재배치.
const SECTIONS: [string, string][] = [
  ['ae-pipeline', '수집 상태'],
  ['ae-rounds', '회차별 예측 기록'],
  ['ae-current', '이번 회차 후보'],
  ['ae-audit', '엔진 성적 · 감사'],
  ['ae-pattern', '당첨 패턴 · 확률'],
  ['ae-engines', '기존 추천 엔진'],
  ['ae-backtest', '전략 백테스트'],
  ['ae-sheets', '용지 학습'],
];

export default function AnalysisEnginePage() {
  return (
    <Stack spacing={3}>
      <Alert severity="info" variant="outlined" sx={{ borderRadius: 2 }}>
        모든 분석은 공식 당첨 이력으로 계산됩니다. 수학적 1등 확률(1장 <strong>1/8,145,060</strong>)은 어떤 통계·백테스트로도 바뀌지
        않으며, 화면의 <strong>수학적 확률 · 과거 백테스트 · 관측 통계 · 공동선택 회피 점수</strong>는 서로 다른 종류의 수치입니다.
      </Alert>

      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
        {SECTIONS.map(([id, label], i) => (
          <Chip key={id} size="small" clickable variant="outlined" label={`${i}. ${label}`}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
        ))}
      </Stack>

      <Group id="ae-pipeline" title="0. 자동 수집 · 검증 상태">
        <PipelineStatusPanel />
      </Group>

      <Group id="ae-rounds" title="1. 회차별 예측 기록"
        note="회차를 고르면 사전 예측·사후 백테스트 번호와 실제 당첨·일치 개수·등수를 봅니다. 탭: 예측 목록 · 엔진 중복 번호 · 조합 겹침 · 엔진별 성적.">
        <RoundPredictionPanel />
      </Group>

      <Group id="ae-current" title="2. 이번 회차 후보 (V12 통합)" note="V8 누수 차단 · V9 엔진 신뢰도 · V10 번호 편향 · V11 무작위 비교를 거친 이번 회차 10조합.">
        <MasterEnginePanel />
      </Group>

      <Group id="ae-audit" title="3. 엔진 성적 · 감사"
        note="엔진 성능 순위·공통번호 교차검증, 회차별 후보군 성적 감사(하락 엔진 제외·보정), 역분석·자동 보정 — 모두 walk-forward 기록 기준.">
        <EngineAuditPanel />
        <RoundAuditPanel />
        <ReverseAnalysisPanel />
      </Group>

      <Group id="ae-pattern" title="4. 당첨 패턴 · 확률 · 회차 통계" note="빈도·온도·동반출현·분포 스냅샷은 '회차' 탭 › 회차 심층 통계에 있습니다.">
        <PatternAtlasPanel />
        <IntegrityProbabilityPanel />
        <WindowStatsPanel />
      </Group>

      <Group id="ae-engines" title="5. 기존 추천 엔진" note="엔진별 결과를 그대로 보여 줍니다 — 각 엔진의 장기 적중은 백테스트에서 무작위와 비교됩니다.">
        <MachineOverviewPanel />
        <ParallelRoundPanel defaultOpen={false} modeLabel="이번회차" />
        <MountOnOpen label="🎰 추첨기(호기) 추천 엔진 열기">
          <RoundRecommendPage embedded />
        </MountOnOpen>
        <MountOnOpen label="🔁 후속출현 분석 열기">
          <PostOccurrencePage />
        </MountOnOpen>
      </Group>

      <Group id="ae-backtest" title="6. 전략 백테스트" note="통계 전략 자체의 walk-forward(각 회차는 그 이전 회차만으로 예측) — 다중검정 보정 후에만 우위를 인정합니다.">
        <FullHistoryBacktestPanel />
        <TicketBacktestPanel />
        <WalkForwardPanel title="전략 Walk-Forward — 균등·빈도·EPO·종합 vs 무작위" />
      </Group>

      <Group
        id="ae-sheets"
        title="7. 용지 학습 엔진 (유튜브 확인 용지)"
        note="유튜브 영상에서 확인한 자동·반자동 용지(검증 통과·용지에 회차 인쇄 확인·추첨 완료 회차)를 실제 당첨과 대조해 학습·검증합니다. 수동 입력 용지는 보존만 하고 학습에는 쓰지 않습니다(설정으로 전환 가능). 이번 회차(추첨 전) 예상 후보는 유튜브에서 확인한 이번 회차 용지에 적용하며, 그 결과(V3 지지 top6)는 사전 예측으로 기록돼 추첨 후 자동 채점됩니다. 새 영상이 판독되면 자동으로 재학습되며, 화면은 열 때만 계산합니다."
      >
        <MountOnOpen label="🧠 학습 엔진 6종 열기 (Feature·NestedCV·SHAP/Drift·Pattern·Round·Overlap)">
          <Stack spacing={1.5}>
            <FeatureLearningPanel sheetIntent="current_round" />
            <NestedCvPanel />
            <ShapDriftPanel />
            <PatternMiningPanel sheetIntent="current_round" />
            <RoundLearningPanel sheetIntent="current_round" />
            <OverlapLearningServerPanel sheetIntent="current_round" />
          </Stack>
        </MountOnOpen>
      </Group>
    </Stack>
  );
}
