/**
 * 로또 분석기 통합 앱 — 일반 기능 + 연구 대시보드
 *
 * 성능: 페이지는 React.lazy 로 라우트 단위 코드 스플리팅.
 *      탭 전환 시 처음 진입한 페이지만 다운로드되어 초기 번들이 작아짐.
 *      Suspense fallback 으로 로딩 인디케이터 노출.
 */
import { Suspense, lazy, useState } from 'react';
import {
  AppBar,
  Box,
  CircularProgress,
  Container,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Typography,
} from '@mui/material';
import AppStatusBar from './components/AppStatusBar';

// 라우트 단위 코드 스플리팅 — 각 페이지는 첫 진입 시 동적 import
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const GeneratorPage = lazy(() => import('./pages/GeneratorPage'));
const SmartPickPage = lazy(() => import('./pages/SmartPickPage'));
const EpoPage = lazy(() => import('./pages/EpoPage'));
const PostOccurrencePage = lazy(() => import('./pages/PostOccurrencePage'));
const ClassicRecommendPage = lazy(() => import('./pages/ClassicRecommendPage'));
const RoundsPage = lazy(() => import('./pages/RoundsPage'));
const RoundRecommendPage = lazy(() => import('./pages/RoundRecommendPage'));
const ResearchPage = lazy(() => import('./pages/ResearchPage'));
const PhotoAnalysisPage = lazy(() => import('./pages/PhotoAnalysisPage'));

function PageFallback() {
  return (
    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ py: 6, justifyContent: 'center' }}>
      <CircularProgress size={24} />
      <Typography variant="body2" color="text.secondary">
        페이지 로딩 중...
      </Typography>
    </Stack>
  );
}

/**
 * 탭 분류:
 *  - 데이터 그룹: dashboard, rounds (관찰)
 *  - 추천 그룹: epo (권장), smart, weighted, classic, machine (5종 차별화)
 *  - 분석 그룹: post, photo, research
 *
 * 라벨링 원칙:
 *  - "AI" 단어는 ML/딥러닝 실체가 있을 때만 사용 (통계 엔진은 "통계"로 표기)
 *  - 각 추천 탭은 핵심 알고리즘 키워드를 라벨에 포함시켜 사용자가 비교 가능하게 함
 *  - EPO 는 가장 발전된 엔진임을 시각적 우선순위 + 권장 표시로 명시
 */
const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'rounds', label: '회차' },
  { id: 'epo', label: '⚡ EPO 추천 (권장)' },
  { id: 'smart', label: '스마트 추천' },
  { id: 'generator', label: '가중치 추천' },
  { id: 'classic', label: '클래식 (수학자)' },
  { id: 'recommend', label: '추첨기 추천' },
  { id: 'post', label: '후속 출현 통계' },
  { id: 'photo', label: '용지 분석' },
  { id: 'research', label: '연구 (v2)' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function App() {
  const [tab, setTab] = useState<TabId>('dashboard');

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="sticky" elevation={0} sx={{ bgcolor: '#121417', borderBottom: '1px solid #33383F' }}>
        <Toolbar>
          <Typography variant="h6" fontWeight={800} sx={{ flexGrow: 1 }}>
            🎱 로또 분석기
          </Typography>
          <AppStatusBar />
        </Toolbar>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ px: 1, bgcolor: '#1C1F24' }}
        >
          {TABS.map((t) => (
            <Tab
              key={t.id}
              value={t.id}
              label={t.label}
              sx={t.id === 'epo' ? { color: '#FBC400', fontWeight: 700 } : undefined}
            />
          ))}
        </Tabs>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Suspense fallback={<PageFallback />}>
          {tab === 'dashboard' && <DashboardPage />}
          {tab === 'rounds' && <RoundsPage />}
          {tab === 'generator' && <GeneratorPage />}
          {tab === 'smart' && <SmartPickPage />}
          {tab === 'epo' && <EpoPage />}
          {tab === 'post' && <PostOccurrencePage />}
          {tab === 'photo' && <PhotoAnalysisPage />}
          {tab === 'recommend' && <RoundRecommendPage />}
          {tab === 'classic' && <ClassicRecommendPage />}
          {tab === 'research' && <ResearchPage />}
        </Suspense>
      </Container>
    </Box>
  );
}
