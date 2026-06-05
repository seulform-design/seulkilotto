/**
 * DashboardScreen — 기획서 핵심 화면 1
 *
 * - GET /api/v1/history/latest 로 최신 회차 당첨번호·보너스 로드
 * - POST /api/v1/analyze/combination 으로 해당 6개 번호의 홀짝·총합·연속 여부 분석
 * - LottoBall: 한국 로또 공식 구간 색상(노랑/파랑/빨강/그레이/초록)
 * - OddEvenBar: 홀·짝 비율 가로 막대 (포인트 컬러만 사용, 배경은 다크 그레이)
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api, CombinationAnalysis, getApiBaseUrl, LatestDraw } from '../api/client';
import { localAnalyzeCombination } from '../api/localFallback';
import { useAppMeta } from '../context/AppMetaContext';
import { LottoBall } from '../components/LottoBall';
import { OddEvenBar } from '../components/OddEvenBar';
import { palette, spacing } from '../theme/colors';

// API 오프라인 시: 최신 추첨 완료 회차 (1226회, 2026-05-30)
const FALLBACK_ROUND: LatestDraw = {
  round: 1226,
  draw_date: '2026-05-30',
  numbers: [4, 6, 13, 17, 26, 28],
  bonus: 41,
};

export default function DashboardScreen() {
  const meta = useAppMeta();
  const [latest, setLatest] = useState<LatestDraw>(FALLBACK_ROUND);
  const [analysis, setAnalysis] = useState<CombinationAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let draw: LatestDraw = FALLBACK_ROUND;
      try {
        draw = await api.getLatestDraw();
        if (!cancelled) {
          setLatest(draw);
          setOffline(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setLatest(FALLBACK_ROUND);
          setOffline(true);
          setError(e instanceof Error ? e.message : '최신 회차 로드 실패');
        }
      }

      try {
        const result = await api.analyzeCombination(draw.numbers);
        if (!cancelled) setAnalysis(result);
      } catch (e: unknown) {
        if (!cancelled) {
          setAnalysis(localAnalyzeCombination(draw.numbers));
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.header}>로또 분석 대시보드</Text>
        <Text style={styles.currentRound}>
          현재 {meta.current_round}회 · 최신 추첨 {latest.round}회
          {meta.is_complete ? ' · 전체 데이터 OK' : ''}
        </Text>

        {offline && (
          <Text style={styles.hint}>
            API 오프라인 - 로컬 CSV 기준 최신 데이터를 표시합니다.{'\n'}
            서버: {getApiBaseUrl()}
          </Text>
        )}

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{latest.round}회 당첨 번호</Text>
            <Text style={styles.cardDate}>{latest.draw_date}</Text>
          </View>

          <View style={styles.ballRow}>
            {latest.numbers.map((n, i) => (
              <LottoBall key={`${latest.round}-${n}-${i}`} number={n} />
            ))}
            <Text style={styles.plus}>+</Text>
            <LottoBall number={latest.bonus} />
          </View>
          <Text style={styles.bonusLabel}>보너스</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>홀짝 비율</Text>

          {loading && (
            <ActivityIndicator color={palette.point.blue} style={{ marginTop: spacing.md }} />
          )}
          {error && !analysis && <Text style={styles.error}>{error}</Text>}

          {analysis && (
            <View style={{ marginTop: spacing.md }}>
              <OddEvenBar odd={analysis.odd_count} even={analysis.even_count} />
              <View style={styles.statRow}>
                <StatChip label="총합" value={`${analysis.sum_total} (${analysis.sum_band})`} />
                <StatChip
                  label="연속 번호"
                  value={analysis.has_consecutive ? '있음' : '없음'}
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Text style={styles.chipValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  container: { padding: spacing.md },
  header: {
    color: palette.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  currentRound: {
    color: palette.point.yellow,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  hint: {
    color: palette.point.yellow,
    fontSize: 12,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  card: {
    backgroundColor: palette.surface,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  cardTitle: { color: palette.textPrimary, fontSize: 16, fontWeight: '700' },
  cardDate: { color: palette.textSecondary, fontSize: 13 },
  ballRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  plus: {
    color: palette.textSecondary,
    fontSize: 20,
    fontWeight: '700',
    marginHorizontal: spacing.xs,
  },
  bonusLabel: {
    color: palette.textSecondary,
    fontSize: 12,
    alignSelf: 'flex-end',
    marginTop: spacing.xs,
  },
  statRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  chip: {
    flex: 1,
    backgroundColor: palette.surfaceAlt,
    borderRadius: 12,
    padding: spacing.md,
  },
  chipLabel: { color: palette.textSecondary, fontSize: 12, marginBottom: spacing.xs },
  chipValue: { color: palette.textPrimary, fontSize: 16, fontWeight: '700' },
  error: { color: palette.point.red, marginTop: spacing.md, fontSize: 12, lineHeight: 18 },
});
