/**
 * 로또 분석기 통합 앱 — 일반 기능 + 연구 대시보드
 *
 * 성능: 페이지는 React.lazy 로 라우트 단위 코드 스플리팅.
 *      탭 전환 시 처음 진입한 페이지만 다운로드되어 초기 번들이 작아짐.
 *      Suspense fallback 으로 로딩 인디케이터 노출.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
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
const PostOccurrencePage = lazy(() => import('./pages/PostOccurrencePage'));
const RoundsPage = lazy(() => import('./pages/RoundsPage'));
const RoundRecommendPage = lazy(() => import('./pages/RoundRecommendPage'));
const PhotoAnalysisPage = lazy(() => import('./pages/PhotoAnalysisPage'));
const ComposedAnalysisPage = lazy(() => import('./pages/ComposedAnalysisPage'));

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
 *  - 데이터: dashboard, rounds
 *  - 분석·추천: composite, recommend, post, photo
 */
const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'rounds', label: '회차' },
  { id: 'composite', label: '🎯 종합 분석' },
  { id: 'recommend', label: '추첨기 추천' },
  { id: 'post', label: '후속 출현 통계' },
  { id: 'photo', label: '용지 분석' },
] as const;

type TabId = (typeof TABS)[number]['id'];
const APP_TAB_STORAGE_KEY = 'lotto:app:active-tab:v1';

function loadInitialTab(): TabId {
  if (typeof window === 'undefined') return 'dashboard';
  try {
    const raw = window.localStorage.getItem(APP_TAB_STORAGE_KEY);
    if (raw && TABS.some((t) => t.id === raw)) {
      return raw as TabId;
    }
  } catch {
    /* ignore */
  }
  return 'dashboard';
}

export default function App() {
  const [tab, setTab] = useState<TabId>(loadInitialTab);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(APP_TAB_STORAGE_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

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
            <Tab key={t.id} value={t.id} label={t.label} />
          ))}
        </Tabs>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Suspense fallback={<PageFallback />}>
          {tab === 'dashboard' && <DashboardPage />}
          {tab === 'rounds' && <RoundsPage />}
          {tab === 'composite' && <ComposedAnalysisPage />}
          {tab === 'post' && <PostOccurrencePage />}
          {tab === 'photo' && <PhotoAnalysisPage />}
          {tab === 'recommend' && <RoundRecommendPage />}
        </Suspense>
      </Container>
    </Box>
  );
}
