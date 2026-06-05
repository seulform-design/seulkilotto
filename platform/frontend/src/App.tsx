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
import ClassicRecommendPage from './pages/ClassicRecommendPage';
import RoundsPage from './pages/RoundsPage';
import RoundRecommendPage from './pages/RoundRecommendPage';
import ResearchPage from './pages/ResearchPage';

const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'rounds', label: '회차' },
  { id: 'generator', label: '번호 생성' },
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
            로또 분석기
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
        {tab === 'dashboard' && <DashboardPage />}
        {tab === 'rounds' && <RoundsPage />}
        {tab === 'generator' && <GeneratorPage />}
        {tab === 'recommend' && <RoundRecommendPage />}
        {tab === 'classic' && <ClassicRecommendPage />}
        {tab === 'research' && <ResearchPage />}
      </Container>
    </Box>
  );
}
