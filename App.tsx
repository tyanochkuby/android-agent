import React, { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NativeTimer from './src/native/NativeTimer';

const durations = [1, 5, 10] as const;
type Duration = (typeof durations)[number];

export default function App() {
  const [minutes, setMinutes] = useState<Duration>(10);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const submitting = useRef(false);

  async function startTimer() {
    if (submitting.current) {
      return;
    }

    submitting.current = true;
    setPending(true);
    setStatus('');

    try {
      await NativeTimer.requestTimer(minutes * 60);
      setStatus(`Sent a ${minutes}-minute timer request to Clock.`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Could not open Clock.',
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.brand}>Android Agent</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Set a timer
          </Text>
          <Text style={styles.description}>
            Choose a duration and send it to your device’s clock app.
          </Text>

          <View style={styles.panel}>
            <Text style={styles.duration}>{minutes} min</Text>
            <View style={styles.presets}>
              {durations.map(duration => (
                <Pressable
                  key={duration}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: duration === minutes,
                    disabled: pending,
                  }}
                  disabled={pending}
                  onPress={() => {
                    setMinutes(duration);
                    setStatus('');
                  }}
                  style={({ pressed }) => [
                    styles.preset,
                    duration === minutes && styles.selected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.presetText}>{duration} min</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: pending, busy: pending }}
              disabled={pending}
              onPress={startTimer}
              style={({ pressed }) => [
                styles.button,
                (pressed || pending) && styles.pressed,
              ]}
            >
              <Text style={styles.buttonText}>
                {pending ? 'Sending…' : 'Start timer'}
              </Text>
            </Pressable>
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {status}
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#151613' },
  content: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 24,
  },
  brand: { color: '#C9F37B', fontSize: 16, fontWeight: '600' },
  title: { color: '#FBFAF4', fontSize: 44, fontWeight: '700', marginTop: 28 },
  description: { color: '#C5C9BD', fontSize: 16, lineHeight: 24, marginTop: 8 },
  panel: {
    backgroundColor: '#22251E',
    borderColor: '#3B4133',
    borderWidth: 1,
    borderRadius: 24,
    marginTop: 28,
    padding: 20,
    gap: 16,
  },
  duration: {
    color: '#FBFAF4',
    fontSize: 52,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preset: {
    borderColor: '#67725E',
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  selected: { backgroundColor: '#3A472D', borderColor: '#C9F37B' },
  presetText: { color: '#FBFAF4', fontSize: 15, fontWeight: '600' },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#C9F37B',
    borderRadius: 14,
    minHeight: 52,
    padding: 12,
  },
  buttonText: { color: '#19220F', fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.72 },
  status: { color: '#C5C9BD', fontSize: 15, lineHeight: 22, marginTop: 16 },
});
