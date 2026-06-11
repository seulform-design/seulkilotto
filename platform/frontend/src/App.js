import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 로또 분석기 통합 앱 — 일반 기능 + 연구 대시보드
 */
import { useState } from 'react';
import { AppBar, Box, Container, Tab, Tabs, Toolbar, Typography, } from '@mui/material';
import AppStatusBar from './components/AppStatusBar';
import DashboardPage from './pages/DashboardPage';
import GeneratorPage from './pages/GeneratorPage';
import SmartPickPage from './pages/SmartPickPage';
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
    { id: 'post', label: '후속출현 AI' },
    { id: 'photo', label: '용지 분석' },
    { id: 'recommend', label: '회차 추천' },
    { id: 'classic', label: '클래식' },
    { id: 'research', label: '연구 분석' },
];
export default function App() {
    const [tab, setTab] = useState('dashboard');
    return (_jsxs(Box, { sx: { minHeight: '100vh', bgcolor: 'background.default' }, children: [_jsxs(AppBar, { position: "sticky", elevation: 0, sx: { bgcolor: '#121417', borderBottom: '1px solid #33383F' }, children: [_jsxs(Toolbar, { children: [_jsx(Typography, { variant: "h6", fontWeight: 800, sx: { flexGrow: 1 }, children: "\uB85C\uB610 \uBD84\uC11D\uAE30" }), _jsx(AppStatusBar, {})] }), _jsx(Tabs, { value: tab, onChange: (_, v) => setTab(v), variant: "scrollable", scrollButtons: "auto", sx: { px: 1, bgcolor: '#1C1F24' }, children: TABS.map((t) => (_jsx(Tab, { value: t.id, label: t.label }, t.id))) })] }), _jsxs(Container, { maxWidth: "lg", sx: { py: 3 }, children: [tab === 'dashboard' && _jsx(DashboardPage, {}), tab === 'rounds' && _jsx(RoundsPage, {}), tab === 'generator' && _jsx(GeneratorPage, {}), tab === 'smart' && _jsx(SmartPickPage, {}), tab === 'post' && _jsx(PostOccurrencePage, {}), tab === 'photo' && _jsx(PhotoAnalysisPage, {}), tab === 'recommend' && _jsx(RoundRecommendPage, {}), tab === 'classic' && _jsx(ClassicRecommendPage, {}), tab === 'research' && _jsx(ResearchPage, {})] })] }));
}
