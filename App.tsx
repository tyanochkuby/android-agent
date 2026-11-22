import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { appLabels, mapsSteps, tasks } from './src/tasks';
import type { Task, TaskRequest } from './src/tasks';

const durations = [1, 5, 10] as const;
type Duration = (typeof durations)[number];

export default function App() {
  const [minutes, setMinutes] = useState<Duration>(10);
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const revision = useRef(0);
  const submitting = useRef(false);
  const states = Object.values(task?.states ?? {});
  const running = states.some(
    ({ phase }) => phase === 'QUEUED' || phase === 'RUNNING',
  );
  const paused = states.some(({ phase }) => phase === 'PAUSED');
  const busy = loading || pending || running || paused;

  useEffect(() => {
    let active = true;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      clearTimeout(timer);
      if (!active || reading) return;
      reading = true;
      const version = revision.current;
      try {
        const snapshot = await tasks.read();
        if (active && !submitting.current && revision.current === version) {
          setTask(snapshot);
        }
      } catch (error) {
        if (active && revision.current === version) {
          setStatus(
            error instanceof Error
              ? error.message
              : 'Could not read task status.',
          );
        }
      }
      reading = false;
      if (active) setLoading(false);
      if (active && running && AppState.currentState === 'active') {
        timer = setTimeout(refresh, 300);
      }
    }

    refresh();
    const subscription = AppState.addEventListener('change', state => {
      clearTimeout(timer);
      if (state === 'active') refresh();
    });
    return () => {
      active = false;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [running]);

  async function handle(operation: () => Promise<Task | void>) {
    if (submitting.current) return;
    submitting.current = true;
    revision.current++;
    setPending(true);
    setStatus('');

    try {
      const snapshot = await operation();
      if (snapshot) setTask(snapshot);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : 'Could not complete the request.',
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function run(steps: TaskRequest['steps']) {
    return handle(() =>
      tasks.submit({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        steps,
      }),
    );
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
                    disabled: busy,
                  }}
                  disabled={busy}
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
              accessibilityState={{ disabled: busy, busy: pending }}
              disabled={busy}
              onPress={() =>
                run([
                  {
                    id: 'timer',
                    action: { type: 'clock.startTimer', seconds: minutes * 60 },
                  },
                ])
              }
              style={({ pressed }) => [
                styles.button,
                (pressed || pending) && styles.pressed,
              ]}
            >
              <Text style={styles.buttonText}>Start timer</Text>
            </Pressable>
          </View>
          <View style={styles.panel}>
            <Text accessibilityRole="header" style={styles.presetText}>
              Google Maps
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => run(mapsSteps())}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Find and open Google Maps</Text>
            </Pressable>
            {__DEV__ && (
              <Pressable
                accessibilityRole="button"
                onPress={() => handle(tasks.openAccessibilitySettings)}
                style={styles.preset}
              >
                <Text style={styles.presetText}>Accessibility settings</Text>
              </Pressable>
            )}
          </View>
          {task && (
            <View style={styles.panel}>
              <Text accessibilityRole="header" style={styles.presetText}>
                Latest task
              </Text>
              {task.request.steps.map(step => {
                const { phase, detail, result } = task.states[step.id];
                return (
                  <Text
                    key={step.id}
                    accessibilityLiveRegion="polite"
                    style={styles.description}
                  >
                    {`${step.id}: ${phase.toLowerCase()}`}
                    {detail && ` · ${detail}`}
                    {result?.type === 'window' &&
                      result.active &&
                      (phase === 'UNKNOWN'
                        ? ` · ${
                            appLabels[result.app]
                          } was active during recovery`
                        : ` · ${appLabels[result.app]} window verified`)}
                    {result?.type === 'matches' &&
                      (result.apps.length === 0
                        ? ' · No matching app'
                        : ` · ${result.apps
                            .map(app => appLabels[app])
                            .join(', ')}`)}
                  </Text>
                );
              })}
              {paused && (
                <Pressable
                  accessibilityRole="button"
                  disabled={pending}
                  style={styles.button}
                  onPress={() => handle(() => tasks.resume(task.request.id))}
                >
                  <Text style={styles.buttonText}>Continue task</Text>
                </Pressable>
              )}
              {busy && !task.cancelled && (
                <Pressable
                  accessibilityRole="button"
                  disabled={pending}
                  style={styles.preset}
                  onPress={() => handle(() => tasks.cancel(task.request.id))}
                >
                  <Text style={styles.presetText}>Cancel remaining steps</Text>
                </Pressable>
              )}
            </View>
          )}
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
