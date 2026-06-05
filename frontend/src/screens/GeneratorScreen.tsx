/**
 * GeneratorScreen - 가중치 기반 번호 추천 화면.
 *
 * - 필터(최근 회차 기준 lookback, 연속 번호 제외)를 선택하고
 *   [번호 생성] 버튼을 누르면 백엔드 /generate/weights 를 호출한다.
 * - 결과는 Animated 페이드인 효과와 함께 표시된다.
 */
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { api, GeneratedCombination } from '../api/client';
import { LottoBall } from '../components/LottoBall';
import { palette, spacing } from '../theme/colors';

const LOOKBACK_OPTIONS = [5, 10, 20]; // 최근 N회차 미출현 기준 선택지

export default function GeneratorScreen() {
  const [lookback, setLookback] = useState(5);
  const [excludeConsecutive, setExcludeConsecutive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedCombination[]>([]);
  const [unseen, setUnseen] = useState<number[]>([]);

  // 결과 페이드인 애니메이션 값
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    fadeAnim.setValue(0); // 애니메이션 초기화
    try {
      const res = await api.generateWeighted({
        nSets: 6,
        lookback,
        excludeConsecutive,
      });
      setResults(res.combinations);
      setUnseen(res.unseen_numbers);

      // 결과 표시와 동시에 부드러운 페이드인 (300ms)
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.header}>번호 생성기</Text>
        <Text style={styles.subtitle}>
          최근 미출현 번호에 +15% 가중치를 부여한 통계 기반 추천
        </Text>

        {/* --- 필터 카드 --- */}
        <View style={styles.card}>
          <Text style={styles.filterLabel}>미출현 기준 (최근 회차)</Text>
          <View style={styles.segmentControl}>
            {LOOKBACK_OPTIONS.map((opt) => {
              const active = lookback === opt;
              return (
                <Pressable
                  key={opt}
                  onPress={() => setLookback(opt)}
                  style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    최근 {opt}회
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.switchRow}>
            <Text style={styles.filterLabel}>연속 번호 제외</Text>
            <Switch
              value={excludeConsecutive}
              onValueChange={setExcludeConsecutive}
              trackColor={{ false: palette.surfaceAlt, true: palette.point.green }}
              thumbColor={palette.textPrimary}
            />
          </View>
        </View>

        {/* --- 생성 버튼 --- */}
        <Pressable
          onPress={handleGenerate}
          disabled={loading}
          style={({ pressed }) => [styles.generateBtn, pressed && styles.generateBtnPressed]}
        >
          {loading ? (
            <ActivityIndicator color="#2A2A2A" />
          ) : (
            <Text style={styles.generateBtnText}>번호 생성</Text>
          )}
        </Pressable>

        {error && <Text style={styles.error}>{error}</Text>}

        {/* --- 결과 (페이드인) --- */}
        {results.length > 0 && (
          <Animated.View style={{ opacity: fadeAnim }}>
            {unseen.length > 0 && (
              <Text style={styles.unseenInfo}>
                가중치 부여 번호: {unseen.join(', ')}
              </Text>
            )}
            {results.map((combo, idx) => (
              <View key={idx} style={styles.resultCard}>
                <Text style={styles.resultIndex}>{String.fromCharCode(65 + idx)}</Text>
                <View style={styles.resultBalls}>
                  {combo.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={38} />
                  ))}
                </View>
                <Text style={styles.resultSum}>합 {combo.sum_total}</Text>
              </View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// =============================================================================
//  StyleSheet (파일 하단에 분리)
// =============================================================================
const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: palette.background,
  },
  container: {
    padding: spacing.md,
  },
  header: {
    color: palette.textPrimary,
    fontSize: 24,
    fontWeight: '800',
  },
  subtitle: {
    color: palette.textSecondary,
    fontSize: 13,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
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
    marginBottom: spacing.md,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: 9,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: palette.point.blue,
  },
  segmentText: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#10202A',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  generateBtn: {
    backgroundColor: palette.point.yellow,
    borderRadius: 14,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  generateBtnPressed: {
    opacity: 0.85,
  },
  generateBtnText: {
    color: '#2A2A2A',
    fontSize: 16,
    fontWeight: '800',
  },
  unseenInfo: {
    color: palette.point.green,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
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
    width: 24,
  },
  resultBalls: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  resultSum: {
    color: palette.textSecondary,
    fontSize: 12,
    marginLeft: spacing.sm,
  },
  error: {
    color: palette.point.red,
    marginBottom: spacing.md,
  },
});
