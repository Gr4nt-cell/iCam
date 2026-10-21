import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

type State = { error: Error | null };

/** Shows the error on screen instead of letting the app close, so problems can be reported. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: '#000', padding: 24, paddingTop: 72, gap: 12 }}>
        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>iCam hit a problem</Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)' }}>Screenshot this and send it so it can be fixed.</Text>
        <ScrollView style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 16, padding: 12 }}>
          <Text selectable style={{ color: '#ffb4ab', fontFamily: 'monospace', fontSize: 12 }}>
            {String(error.message)}
            {'\n\n'}
            {String(error.stack ?? '').slice(0, 3000)}
          </Text>
        </ScrollView>
        <Pressable
          onPress={() => this.setState({ error: null })}
          style={{ backgroundColor: '#8ab4f8', borderRadius: 22, height: 46, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: '#0b1f44', fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
