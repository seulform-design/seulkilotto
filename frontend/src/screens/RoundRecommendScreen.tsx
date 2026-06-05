/**
 * RoundRecommendScreen - 다음 회차 호기 기반 추천 5게임.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api, RoundRecommendResponse } from '../api/client';
import { useAppMeta } from '../context/AppMetaContext';
import { LottoBall } from '../components/LottoBall';
import { palette, spacing } from '../theme/colors';

type MachineChoice = 'auto' | 1 | 2 | 3;

export default function RoundRecommendScreen() {
  const meta = useAppMeta();
  const [machine, setMachine] = useState<MachineChoice>('auto');
  const [data, setData] = useState<RoundRecommendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    fadeAnim.setValue(0);
    try {
      const res = await api.getRoundRecommend(
        machine === 'auto' ? undefined : machine
      );
      setData(res);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 320,
        useNativeDriver: true,
      }).start();
    } catch (e: unknown) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [machine, fadeAnim]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.header}>회차 추천</Text>
        <Text style={styles.subtitle}>
          {meta.current_round}회 추첨 기준 · 호기 패턴 5게임 (데이터 {meta.row_count}건)
        </Text>

        {data && (
          <View style={styles.roundCard}>
            <Text style={styles.roundLabel}>추천 대상</Text>
            <Text style={styles.roundValue}>{data.next_round}회</Text>
            <Text style={styles.roundMeta}>
              예상 추첨일 {data.next_draw_date} · {data.machine_id}호기
              {data.machine_id !== data.auto_machine_id
                ? ` (자동예측 ${data.auto_machine_id}호기)`
                : ''}
            </Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.filterLabel}>분석 호기</Text>
          <View style={styles.segmentControl}>
            {(['auto', 1, 2, 3] as MachineChoice[]).map((opt) => {
              const active = machine === opt;
              const label = opt === 'auto' ? '자동' : `${opt}호기`;
              return (
                <Pressable
                  key={String(opt)}
                  onPress={() => setMachine(opt)}
                  style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable
          onPress={load}
          disabled={loading}
          style={({ pressed }) => [styles.generateBtn, pressed && styles.generateBtnPressed]}
        >
          {loading ? (
            <ActivityIndicator color="#2A2A2A" />
          ) : (
            <Text style={styles.generateBtnText}>회차 추천 받기</Text>
          )}
        </Pressable>

        {error && <Text style={styles.error}>{error}</Text>}
        {data?.warning && <Text style={styles.warn}>{data.warning}</Text>}

        {data && data.stats.draw_count > 0 && (
          <View style={styles.statsCard}>
            <Text style={styles.statsTitle}>호기 통계 요약</Text>
            <Text style={styles.statsLine}>
              분석 {data.stats.draw_count}회 · 평균합 {data.stats.avg_sum} · 홀{' '}
              {data.stats.avg_odd}
            </Text>
            <Text style={styles.statsSub}>최다 출현 TOP 5</Text>
            <Text style={styles.statsNums}>
              {data.stats.hot_top5.map((h) => `${h.number}(${h.count})`).join('  ')}
            </Text>
            <Text style={styles.statsSub}>미출현 TOP 5</Text>
            <Text style={styles.statsNums}>
              {data.stats.cold_top5.map((c) => `${c.number}(${c.gap_rounds})`).join('  ')}
            </Text>
          </View>
        )}

        {data && data.combinations.length > 0 && (
          <Animated.View style={{ opacity: fadeAnim }}>
            <Text style={styles.resultTitle}>추천 5게임</Text>
            <Text style={styles.resultHint}>{data.compose_rule} · {data.filter_rule}</Text>
            {data.combinations.map((combo, idx) => (
              <View key={idx} style={styles.resultCard}>
                <Text style={styles.resultIndex}>{idx + 1}</Text>
                <View style={styles.resultBalls}>
                  {combo.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={36} />
                  ))}
                </View>
                <Text style={styles.resultSum}>
                  합{combo.sum_total}{'\n'}홀{combo.odd_count}
                </Text>
              </View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  container: { padding: spacing.md, paddingBottom: spacing.xl },
  header: { color: palette.textPrimary, fontSize: 24, fontWeight: '800' },
  subtitle: {
    color: palette.textSecondary,
    fontSize: 13,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  roundCard: {
    backgroundColor: palette.point.blue,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  roundLabel: { color: '#10202A', fontSize: 12, fontWeight: '600' },
  roundValue: { color: '#10202A', fontSize: 32, fontWeight: '800' },
  roundMeta: { color: '#10202A', fontSize: 12, marginTop: spacing.xs },
  card: {
    backgroundColor: palette.surface,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  filterLabel: {
    color: palette.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  segmentControl: {
    flexDirection: 'row',
    backgroundColor: palette.surfaceAlt,
    borderRadius: 12,
    padding: 4,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: 9,
    alignItems: 'center',
  },
  segmentBtnActive: { backgroundColor: palette.point.green },
  segmentText: { color: palette.textSecondary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: '#1A2A10' },
  generateBtn: {
    backgroundColor: palette.point.yellow,
    borderRadius: 14,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  generateBtnPressed: { opacity: 0.85 },
  generateBtnText: { color: '#2A2A2A', fontSize: 16, fontWeight: '800' },
  error: { color: palette.point.red, fontSize: 12, lineHeight: 18, marginBottom: spacing.md },
  warn: { color: palette.point.yellow, fontSize: 12, marginBottom: spacing.md },
  statsCard: {
    backgroundColor: palette.surface,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  statsTitle: { color: palette.textPrimary, fontSize: 15, fontWeight: '700' },
  statsLine: { color: palette.textSecondary, fontSize: 12, marginTop: spacing.xs },
  statsSub: { color: palette.point.yellow, fontSize: 12, marginTop: spacing.sm },
  statsNums: { color: palette.textPrimary, fontSize: 13, marginTop: 4 },
  resultTitle: {
    color: palette.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  resultHint: { color: palette.textSecondary, fontSize: 11, marginBottom: spacing.sm },
  resultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: palette.border,
  },
  resultIndex: {
    color: palette.textSecondary,
    fontSize: 16,
    fontWeight: '800',
    width: 22,
  },
  resultBalls: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  resultSum: {
    color: palette.textSecondary,
    fontSize: 11,
    textAlign: 'right',
    marginLeft: spacing.xs,
  },
});
