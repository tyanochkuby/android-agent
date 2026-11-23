import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { appLabels, mapsSteps, tasks } from './src/tasks';
import type { Task, TaskRequest } from './src/tasks';
import { runAgent } from './src/agent';
import { agentTools } from './src/agentTools';
import { companion } from './src/companion';
import { conversation, conversationContext } from './src/conversation';
import type { ConversationTurn } from './src/conversation';

const durations = [1, 5, 10] as const;
type Duration = (typeof durations)[number];

export default function App() {
  const [minutes, setMinutes] = useState<Duration>(10);
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [connected, setConnected] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [shareScreen, setShareScreen] = useState(false);
  const [promptStatus, setPromptStatus] = useState('');
  const [history, setHistory] = useState<ConversationTurn[] | null>(null);
  const [screenReply, setScreenReply] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const revision = useRef(0);
  const submitting = useRef(false);
  const states = Object.values(task?.states ?? {});
  const running = states.some(
    ({ phase }) => phase === 'QUEUED' || phase === 'RUNNING',
  );
  const paused = states.some(({ phase }) => phase === 'PAUSED');
  const busy = loading || pending || running || paused;

  useEffect(() => {
    if (!__DEV__) return;
    let active = true;
    conversation.read().then(
      turns => {
        if (active) setHistory(turns);
      },
      () => {
        if (active) {
          setHistory([]);
          setPromptStatus('Could not load conversation history.');
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

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

  function connect(signIn: boolean) {
    return handle(async () => {
      setConnected(false);
      const bridge = companion(pairingCode.trim());
      const connection = await (signIn ? bridge.signIn() : bridge.check());
      setConnected(connection.ready);
      setPromptStatus(
        connection.error ??
          (connection.ready
            ? ''
            : connection.signingIn
            ? 'Finish sign-in on the companion computer, then check the connection.'
            : 'Sign in with ChatGPT on the companion computer.'),
      );
    });
  }

  function askAgent() {
    return handle(async () => {
      setShareScreen(false);
      setScreenReply(null);
      setPromptStatus('Working…');
      const code = pairingCode.trim();
      const redactCode = (value: string) =>
        value.replaceAll(code, '[pairing code removed]');
      const message = redactCode(prompt.trim());

      let id: string;
      let previous: ConversationTurn[];
      try {
        previous = await conversation.read();
        id = await conversation.start(message);
      } catch {
        setPromptStatus('Could not save the prompt. Please try again.');
        return;
      }
      const recent = previous.slice(-49);
      setHistory([...recent, { id, prompt: message, reply: null }]);
      setPrompt('');

      let result;
      try {
        result = await runAgent(
          message,
          companion(code).model,
          agentTools,
          shareScreen,
          conversationContext(previous).map(turn => ({
            ...turn,
            content: redactCode(turn.content),
          })),
        );
      } catch (error) {
        setConnected(false);
        setPromptStatus(
          error instanceof Error ? error.message : 'The agent stopped.',
        );
        return (await tasks.read()) ?? undefined;
      }

      const reply = redactCode(result.message);
      setPromptStatus('');
      if (result.usedScreenObservation) {
        setScreenReply({ id, message: reply });
      } else {
        try {
          await conversation.saveReply(id, reply);
          setHistory([...recent, { id, prompt: message, reply }]);
        } catch {
          setPromptStatus('Could not save the reply.');
        }
      }
      return (await tasks.read()) ?? undefined;
    });
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.brand}>Android Agent</Text>
          {__DEV__ && (
            <View style={styles.panel}>
              <Text accessibilityRole="header" style={styles.presetText}>
                Ask Android Agent
              </Text>
              <Text style={styles.description}>
                Connect to the local companion to use your ChatGPT plan.
              </Text>
              <TextInput
                accessibilityLabel="Companion pairing code"
                placeholder="Companion pairing code"
                placeholderTextColor="#A4AB9B"
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                maxLength={32}
                editable={!busy}
                value={pairingCode}
                onChangeText={value => {
                  setPairingCode(value);
                  setConnected(false);
                  setShareScreen(false);
                  setPromptStatus('');
                }}
              />
              {!connected && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      busy || history === null || pairingCode.length !== 32
                    }
                    onPress={() => connect(true)}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Sign in with ChatGPT</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      busy || history === null || pairingCode.length !== 32
                    }
                    onPress={() => connect(false)}
                    style={styles.preset}
                  >
                    <Text style={styles.presetText}>Check connection</Text>
                  </Pressable>
                </>
              )}
              {connected && (
                <>
                  <Text style={styles.presetText}>Using ChatGPT plan</Text>
                  <Text style={styles.description}>
                    Prompts are saved on this device. Keep passwords and keys
                    out of the conversation.
                  </Text>
                  <TextInput
                    accessibilityLabel="Agent prompt"
                    placeholder="What should Android do?"
                    placeholderTextColor="#A4AB9B"
                    style={styles.input}
                    maxLength={2_000}
                    editable={!busy}
                    value={prompt}
                    onChangeText={value => {
                      setPrompt(value);
                      setShareScreen(false);
                    }}
                  />
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked: shareScreen,
                      disabled: busy,
                    }}
                    disabled={busy}
                    onPress={() => setShareScreen(value => !value)}
                    style={[styles.preset, shareScreen && styles.selected]}
                  >
                    <Text style={styles.presetText}>
                      {shareScreen ? '☑' : '☐'} Allow the agent to open an
                      installed app and share its visible text and controls with
                      ChatGPT for this prompt
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !prompt.trim()}
                    onPress={askAgent}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Run prompt</Text>
                  </Pressable>
                </>
              )}
              {!!promptStatus && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={styles.description}
                >
                  {promptStatus}
                </Text>
              )}
              {!!history?.length && (
                <View style={styles.history}>
                  <Text accessibilityRole="header" style={styles.presetText}>
                    Conversation history
                  </Text>
                  {history
                    .slice()
                    .reverse()
                    .map(turn => (
                      <View key={turn.id} style={styles.turn}>
                        <Text style={styles.presetText}>You</Text>
                        <Text selectable style={styles.description}>
                          {turn.prompt}
                        </Text>
                        <Text style={styles.presetText}>Android Agent</Text>
                        <Text
                          selectable
                          accessibilityLiveRegion="polite"
                          style={styles.description}
                        >
                          {screenReply?.id === turn.id
                            ? screenReply.message
                            : turn.reply ?? 'No saved reply'}
                        </Text>
                      </View>
                    ))}
                </View>
              )}
            </View>
          )}
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
              {(running || paused) && !task.cancelled && (
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
  input: {
    color: '#FBFAF4',
    borderColor: '#67725E',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  history: { gap: 12 },
  turn: { borderTopWidth: 1, borderColor: '#3B4133', paddingTop: 12, gap: 4 },
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
