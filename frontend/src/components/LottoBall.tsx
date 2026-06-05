/**
 * LottoBall - 한국 로또 공식 색상의 원형 번호 배지.
 * 번호 구간별로 노랑/파랑/빨강/그레이/초록 컬러를 자동 적용한다.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getBallColor } from '../theme/colors';

interface LottoBallProps {
  number: number;
  size?: number; // 지름(px)
}

export function LottoBall({ number, size = 44 }: LottoBallProps) {
  const backgroundColor = getBallColor(number);
  // 노랑/초록 등 밝은 배경에서는 글자를 어둡게 처리해 가독성 확보
  const isLight = number <= 10 || number > 40;
  const textColor = isLight ? '#2A2A2A' : '#FFFFFF';

  return (
    <View
      style={[
        styles.ball,
        { width: size, height: size, borderRadius: size / 2, backgroundColor },
      ]}
    >
      <Text style={[styles.text, { color: textColor, fontSize: size * 0.4 }]}>
        {number}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ball: {
    alignItems: 'center',
    justifyContent: 'center',
    // 입체감을 위한 가벼운 그림자
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  text: {
    fontWeight: '700',
  },
});
