/**
 * OddEvenBar - 홀짝 비율을 가로형 누적 바 그래프로 표현하는 컴포넌트.
 * 홀수는 파랑, 짝수는 빨강 포인트 컬러를 사용한다.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '../theme/colors';

interface OddEvenBarProps {
  odd: number;
  even: number;
}

export function OddEvenBar({ odd, even }: OddEvenBarProps) {
  const total = odd + even || 1; // 0 나눗셈 방지
  const oddPct = (odd / total) * 100;
  const evenPct = (even / total) * 100;

  return (
    <View>
      <View style={styles.labelRow}>
        <Text style={styles.label}>홀수 {odd}개</Text>
        <Text style={styles.label}>짝수 {even}개</Text>
      </View>

      {/* flex 비율로 좌(홀)/우(짝) 영역을 채우는 누적 바 */}
      <View style={styles.track}>
        <View style={[styles.segment, styles.left, { flex: oddPct, backgroundColor: palette.odd }]}>
          {oddPct >= 15 && <Text style={styles.segText}>{Math.round(oddPct)}%</Text>}
        </View>
        <View style={[styles.segment, styles.right, { flex: evenPct, backgroundColor: palette.even }]}>
          {evenPct >= 15 && <Text style={styles.segText}>{Math.round(evenPct)}%</Text>}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  label: {
    color: palette.textSecondary,
    fontSize: 13,
  },
  track: {
    flexDirection: 'row',
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: palette.surfaceAlt,
  },
  segment: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  left: {},
  right: {},
  segText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
});
