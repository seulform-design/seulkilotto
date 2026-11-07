/**
 * 로또 분석기 통합 앱 — 일반 기능 + 연구 대시보드
 *
 * 성능: 페이지는 React.lazy 로 라우트 단위 코드 스플리팅.
 *      탭 전환 시 처음 진입한 페이지만 다운로드되어 초기 번들이 작아짐.
 *      Suspense fallback 으로 로딩 인디케이터 노출.
 *
 * IA: 종합분석·추첨기 추천은 상단 탭에서 제거하고
 *     용지분석 → ③ 번호추천 안으로 이동(딥링크·임베드).
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

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const RoundsPage = lazy(() => import('./pages/RoundsPage'));
const RecommendPage = lazy(() => import('./pages/RecommendPage'));
const FortunePickPage = lazy(() => import('./pages/FortunePickPage'));

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
 *  - 데이터: dashboard, rounds(회차 심층분석)
 *  - 추천: recommend(추첨데이터 기반 앙상블), fortune
 *  용지(자동/반자동) 입력 시스템은 폐지됨.
 */
const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'rounds', label: '회차' },
  { id: 'recommend', label: '🎯 번호추천' },
  { id: 'fortune', label: '👵 할매 예상' },
] as const;

type TabId = (typeof TABS)[number]['id'];
const APP_TAB_STORAGE_KEY = 'lotto:app:active-tab:v1';

/** 폐지된 구 탭(photo/composite/recommend-focus/post) → 번호추천으로 이동 */
const LEGACY_TAB_REMAP: Record<string, TabId> = {
  photo: 'recommend',
  composite: 'recommend',
  post: 'recommend',
};

function loadInitialTab(): TabId {
  if (typeof window === 'undefined') return 'dashboard';
  try {
    const raw = window.localStorage.getItem(APP_TAB_STORAGE_KEY);
    if (raw && LEGACY_TAB_REMAP[raw]) {
      const mapped = LEGACY_TAB_REMAP[raw];
      window.localStorage.setItem(APP_TAB_STORAGE_KEY, mapped);
      return mapped;
    }
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
          onChange={(_, v: TabId) => setTab(v)}
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
          {tab === 'recommend' && <RecommendPage />}
          {tab === 'fortune' && <FortunePickPage />}
        </Suspense>
      </Container>
    </Box>
  );
}
