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
import { setPhotoFocus } from './utils/photoFocus';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const PostOccurrencePage = lazy(() => import('./pages/PostOccurrencePage'));
const RoundsPage = lazy(() => import('./pages/RoundsPage'));
const PhotoAnalysisPage = lazy(() => import('./pages/PhotoAnalysisPage'));
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
 *  - 데이터: dashboard, rounds
 *  - 분석·추천: photo(용지=번호추천에 종합·추첨기 포함), post
 */
const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'rounds', label: '회차' },
  { id: 'photo', label: '용지 분석' },
  { id: 'post', label: '후속 출현 통계' },
  { id: 'fortune', label: '👵 할매 예상' },
] as const;

type TabId = (typeof TABS)[number]['id'];
const APP_TAB_STORAGE_KEY = 'lotto:app:active-tab:v1';

/** 구 상단탭 → 용지분석 + 포커스 */
const LEGACY_TAB_FOCUS: Record<string, 'composite' | 'machine'> = {
  composite: 'composite',
  recommend: 'machine',
};

function loadInitialTab(): TabId {
  if (typeof window === 'undefined') return 'dashboard';
  try {
    const raw = window.localStorage.getItem(APP_TAB_STORAGE_KEY);
    if (raw && LEGACY_TAB_FOCUS[raw]) {
      setPhotoFocus(LEGACY_TAB_FOCUS[raw]);
      window.localStorage.setItem(APP_TAB_STORAGE_KEY, 'photo');
      return 'photo';
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
          {tab === 'post' && <PostOccurrencePage />}
          {tab === 'photo' && <PhotoAnalysisPage />}
          {tab === 'fortune' && <FortunePickPage />}
        </Suspense>
      </Container>
    </Box>
  );
}
