import React, { Component, ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '../theme/colors';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.box}>
          <Text style={styles.title}>화면 오류</Text>
          <Text style={styles.msg}>{this.state.message}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  box: {
    flex: 1,
    backgroundColor: palette.background,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  title: { color: palette.point.red, fontSize: 18, fontWeight: '700' },
  msg: { color: palette.textSecondary, marginTop: spacing.sm, lineHeight: 20 },
});
