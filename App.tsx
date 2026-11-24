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
import { conversation } from './src/conversation';
import type { Outcome, Turn } from './src/conversation';

const durations = [1, 5, 10] as const;
type Duration = (typeof durations)[number];
const historyPage = 20;

// Keep in-flight work and pending writes across component remounts in the same runtime.
let submission: Promise<string | undefined> | null = null;
const promptSavedListeners = new Set<() => void>();
let startAttempt: string | null = null;
let unsaved: { id: string; outcome: Outcome } | null = null;

export default function App() {
  const [minutes, setMinutes] = useState<Duration>(10);
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const connected = sessionId !== undefined;
  const [shareHistory, setShareHistory] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [shareScreen, setShareScreen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [history, setHistory] = useState<Turn[]>([]);
  const [earlier, setEarlier] = useState(false);
  const revision = useRef(0);
  const states = Object.values(task?.states ?? {});
  const running = states.some(
    ({ phase }) => phase === 'QUEUED' || phase === 'RUNNING',
  );
  const paused = states.some(({ phase }) => phase === 'PAUSED');
  const busy = loading || pending || running || paused;

  function updateTask(snapshot: Task | null) {
    setTask(snapshot);
    if (!snapshot) return;
    setHistory(current =>
      current.map(turn =>
        turn.tasks.some(linked => linked.request.id === snapshot.request.id)
          ? {
              ...turn,
              tasks: turn.tasks.map(linked =>
                linked.request.id === snapshot.request.id ? snapshot : linked,
              ),
            }
          : turn,
      ),
    );
  }

  async function loadHistory(before: string | null = null) {
    const page = await conversation.read(historyPage, before);
    if (before !== null || page.length === historyPage) {
      setEarlier(page.length === historyPage);
    }
    setHistory(current => {
      if (before !== null) {
        const ids = new Set(current.map(turn => turn.id));
        return [...current, ...page.filter(turn => !ids.has(turn.id))];
      }
      const oldest = page.at(-1)?.id;
      return [
        ...page,
        ...current.filter(
          turn => oldest !== undefined && BigInt(turn.id) < BigInt(oldest),
        ),
      ];
    });
  }

  useEffect(() => {
    let active = true;
    let historyRead = 0;
    const pendingSubmission = submission;
    async function refreshHistory() {
      if (!__DEV__) return;
      const read = ++historyRead;
      try {
        const page = await conversation.read(historyPage);
        if (active && read === historyRead) {
          setHistory(page);
          setEarlier(page.length === historyPage);
        }
      } catch {
        if (active && read === historyRead)
          setAnswer('Could not load the conversation.');
      }
    }

    if (pendingSubmission) {
      setPending(true);
      promptSavedListeners.add(refreshHistory);
    }
    (async () => {
      await refreshHistory();
      if (active && !pendingSubmission && unsaved)
        setAnswer(unsavedText(unsaved.outcome));
      if (pendingSubmission) {
        const failure = await pendingSubmission;
        if (!active) return;
        const [snapshot] = await Promise.all([
          tasks.read().catch(() => undefined),
          refreshHistory(),
        ]);
        if (active) {
          if (snapshot !== undefined) updateTask(snapshot);
          if (failure !== undefined) setStatus(failure);
          if (unsaved) setAnswer(unsavedText(unsaved.outcome));
          setPending(false);
        }
      }
    })();
    return () => {
      active = false;
      promptSavedListeners.delete(refreshHistory);
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
        if (active && submission === null && revision.current === version) {
          updateTask(snapshot);
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

  function handle(operation: () => Promise<Task | void>) {
    if (submission) return;
    submission = runSubmission(operation);
    return submission;
  }

  async function runSubmission(operation: () => Promise<Task | void>) {
    revision.current++;
    setPending(true);
    setStatus('');

    try {
      const snapshot = await Promise.resolve().then(operation);
      if (snapshot) updateTask(snapshot);
    } catch (error) {
      const failure =
        error instanceof Error
          ? error.message
          : 'Could not complete the request.';
      setStatus(failure);
      return failure;
    } finally {
      submission = null;
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
      setSessionId(undefined);
      setShareHistory(false);
      const bridge = companion(pairingCode.trim());
      const connection = await (signIn ? bridge.signIn() : bridge.check());
      setSessionId(connection.ready ? connection.sessionId : undefined);
      setAnswer(
        connection.error ??
          (connection.ready
            ? connection.sessionId
              ? ''
              : 'Restart the companion with the current build.'
            : connection.signingIn
            ? 'Finish sign-in on the companion computer, then check the connection.'
            : 'Sign in with ChatGPT on the companion computer.'),
      );
    });
  }

  async function save(id: string, outcome: Outcome) {
    try {
      await conversation.finish(id, outcome);
      unsaved = null;
      return true;
    } catch {
      unsaved = { id, outcome };
      return false;
    }
  }

  function askAgent() {
    return handle(async () => {
      setAnswer('');
      setShareScreen(false);
      const message = prompt.trim();
      if (unsaved) await save(unsaved.id, unsaved.outcome);
      // Starting succeeds only when no turn is running, so an outcome still unsaved here is stale.
      const attempt = (startAttempt ??= `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`);
      const id = await conversation.start(message, attempt).catch(error => {
        setAnswer(
          error instanceof Error ? error.message : 'Could not save the prompt.',
        );
        return null;
      });
      if (id === null) return;
      startAttempt = null;
      unsaved = null;
      setPrompt('');
      promptSavedListeners.forEach(refresh => refresh());
      await loadHistory().catch(() => {});

      let outcome: Outcome;
      try {
        const { model } = companion(pairingCode.trim(), sessionId);
        outcome = {
          reply: await runAgent(
            message,
            model,
            agentTools(id),
            shareScreen,
            shareHistory ? await conversation.context(model) : [],
          ),
        };
      } catch (error) {
        setSessionId(undefined);
        outcome = {
          failure:
            (error instanceof Error && error.message.trim()) ||
            'The agent stopped.',
        };
      }
      if (!(await save(id, outcome))) {
        setAnswer(unsavedText(outcome));
      }
      await loadHistory().catch(() => {});
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
                  setSessionId(undefined);
                  setShareHistory(false);
                  setAnswer('');
                }}
              />
              {!connected && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || pairingCode.length !== 32}
                    onPress={() => connect(true)}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Sign in with ChatGPT</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || pairingCode.length !== 32}
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
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel="Share saved conversation"
                    accessibilityState={{
                      checked: shareHistory,
                      disabled: busy,
                    }}
                    disabled={busy}
                    onPress={() => setShareHistory(value => !value)}
                    style={[styles.preset, shareHistory && styles.selected]}
                  >
                    <Text style={styles.presetText}>
                      {shareHistory ? '☑' : '☐'} Share saved conversation with
                      this connection
                    </Text>
                  </Pressable>
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
                    accessibilityLabel="Share screen for this prompt"
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
                    onPress={() => {
                      askAgent();
                    }}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Run prompt</Text>
                  </Pressable>
                </>
              )}
              {!!answer && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={styles.description}
                >
                  {answer}
                </Text>
              )}
              {history.length > 0 && (
                <View style={styles.history}>
                  <Text accessibilityRole="header" style={styles.presetText}>
                    Conversation
                  </Text>
                  {earlier && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        loadHistory(history[history.length - 1].id).catch(() =>
                          setAnswer('Could not load earlier turns.'),
                        )
                      }
                      style={styles.preset}
                    >
                      <Text style={styles.presetText}>Show earlier</Text>
                    </Pressable>
                  )}
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
                        <Text selectable style={styles.description}>
                          {turn.id === unsaved?.id && turn.status === 'RUNNING'
                            ? 'Result pending save.'
                            : turnText(turn)}
                        </Text>
                        {turn.tasks.flatMap(linked =>
                          linked.request.steps.map(step => (
                            <Text
                              key={`${linked.request.id}-${step.id}`}
                              style={styles.description}
                            >
                              {`${step.id}: ${(task?.request.id ===
                              linked.request.id
                                ? task
                                : linked
                              ).states[step.id].phase.toLowerCase()}`}
                            </Text>
                          )),
                        )}
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

function unsavedText(outcome: Outcome) {
  const text = 'reply' in outcome ? outcome.reply : outcome.failure;
  return `${text}\n\nCould not save this result. It will be saved again with your next prompt.`;
}

function turnText({ status, reply, detail }: Turn) {
  switch (status) {
    case 'RUNNING':
      return 'Working…';
    case 'COMPLETED':
      return reply;
    case 'FAILED':
      return detail ?? 'The agent stopped.';
    case 'INTERRUPTED':
      return detail ?? 'Interrupted before a reply was saved.';
  }
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
