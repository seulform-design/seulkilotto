/**
 * 로또 분석기 통합 앱 — 일반 기능 + 연구 대시보드
 */
import { useState } from 'react';
import {
  AppBar,
  Box,
  Container,
  Tab,
  Tabs,
  Toolbar,
  Typography,
} from '@mui/material';
import AppStatusBar from './components/AppStatusBar';
import DashboardPage from './pages/DashboardPage';
import GeneratorPage from './pages/GeneratorPage';
import SmartPickPage from './pages/SmartPickPage';
import EpoPage from './pages/EpoPage';
import PostOccurrencePage from './pages/PostOccurrencePage';
import ClassicRecommendPage from './pages/ClassicRecommendPage';
import RoundsPage from './pages/RoundsPage';
import RoundRecommendPage from './pages/RoundRecommendPage';
import ResearchPage from './pages/ResearchPage';
import PhotoAnalysisPage from './pages/PhotoAnalysisPage';

const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'rounds', label: '회차' },
  { id: 'generator', label: '번호 생성' },
  { id: 'smart', label: '스마트' },
  { id: 'epo', label: '⚡ EPO' },
  { id: 'post', label: '후속출현 AI' },
  { id: 'photo', label: '용지 분석' },
  { id: 'recommend', label: '회차 추천' },
  { id: 'classic', label: '클래식' },
  { id: 'research', label: '연구 분석' },
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
      </Container>
    </Box>
  );
}
