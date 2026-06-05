import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ErrorBoundary } from './src/components/ErrorBoundary';
import { AppMetaProvider, useAppMeta } from './src/context/AppMetaContext';
import DashboardScreen from './src/screens/DashboardScreen';
import GeneratorScreen from './src/screens/GeneratorScreen';
import RoundRecommendScreen from './src/screens/RoundRecommendScreen';
import { palette, spacing } from './src/theme/colors';

/** 기획서 핵심 2화면(대시보드·생성기) + 운영용 회차 추천 */
type Tab = 'dashboard' | 'generator' | 'recommend';

function AppShell() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const meta = useAppMeta();

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {!meta.is_complete && meta.source !== 'mock' && (
        <Text style={styles.banner}>
          데이터 {meta.row_count}건 · 누락 {meta.gap_count}회차 ({meta.source})
        </Text>
      )}
      <View style={styles.screen}>
        {tab === 'dashboard' && <DashboardScreen />}
        {tab === 'generator' && <GeneratorScreen />}
        {tab === 'recommend' && <RoundRecommendScreen />}
      </View>
      <View style={styles.tabBar}>
        <TabButton label="대시보드" active={tab === 'dashboard'} onPress={() => setTab('dashboard')} />
        <TabButton label="번호 생성" active={tab === 'generator'} onPress={() => setTab('generator')} />
        <TabButton label="회차 추천" active={tab === 'recommend'} onPress={() => setTab('recommend')} />
      </View>
    </View>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppMetaProvider>
        <AppShell />
      </AppMetaProvider>
    </ErrorBoundary>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.tabBtn} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  banner: {
    color: palette.point.yellow,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: spacing.xs,
    backgroundColor: palette.surfaceAlt,
  },
  screen: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
  },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm },
  tabText: { color: palette.textSecondary, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: palette.point.yellow },
});
