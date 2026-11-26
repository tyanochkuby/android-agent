import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { appLabels, tasks } from './src/tasks';
import type { Task } from './src/tasks';
import { contextBudget, fallbackContextTokens } from './src/agent';
import { agentTools } from './src/agentTools';
import { chatgpt } from './src/chatgpt';
import type { Account, Connection } from './src/chatgpt';
import { companion } from './src/companion';
import { conversation } from './src/conversation';
import type { Outcome, Turn } from './src/conversation';
import {
  ask,
  compactor,
  connectedModel,
  exclusive,
  prompts,
  recoverChatGPTConnection,
} from './src/prompts';
import { emptySettings, settings } from './src/settings';
import NativeTasks from './src/native/NativeTasks';
import type { Settings } from './src/settings';

const historyPage = 20;

export default function App() {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(prompts.busy);
  const [status, setStatus] = useState('');
  const [config, setConfig] = useState<Settings>(emptySettings);
  const { pairingCode, session, shareHistory } = config;
  const connected = session !== undefined;
  const [account, setAccount] = useState<Account | null>(null);
  const [speechModel, setSpeechModel] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [shareScreen, setShareScreen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [history, setHistory] = useState<Turn[]>([]);
  const [olderPage, setOlderPage] = useState<boolean | null>(null);
  const earlier = olderPage ?? history.length >= historyPage;
  const revision = useRef(0);
  const historyRead = useRef(0);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lastScrolledTurn = useRef<string | undefined>(undefined);
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

  // Reads the newest page, or the page before `before`, and merges it with loaded turns.
  async function loadHistory(before: string | null = null) {
    const read = before === null ? ++historyRead.current : historyRead.current;
    const page = await conversation.read(historyPage, before);
    if (before === null && read !== historyRead.current) return;
    if (before !== null) {
      setOlderPage(page.length === historyPage);
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
    NativeTasks.speechModelStatus()
      .then(saved => active && setSpeechModel(saved))
      .catch(() => {});
    const unsubscribeSettings = settings.subscribe(setConfig);
    settings
      .read()
      .then(saved => active && setConfig(saved))
      .catch(() => {});
    chatgpt
      .status()
      .then(saved => active && setAccount(saved))
      .catch(() => {});
    loadHistory().catch(
      () => active && setAnswer('Could not load the conversation.'),
    );
    if (!prompts.busy && prompts.unsaved)
      setAnswer(unsavedText(prompts.unsaved.outcome));
    // Typed and voice prompts share one runtime, so either can finish while this screen is open.
    const unsubscribe = prompts.subscribe(() => {
      if (!active) return;
      setPending(prompts.busy);
      loadHistory().catch(() => {});
      if (prompts.busy) return;
      chatgpt
        .status()
        .then(saved => active && setAccount(saved))
        .catch(() => {});
      tasks
        .read()
        .then(snapshot => active && updateTask(snapshot))
        .catch(() => {});
      if (prompts.unsaved) setAnswer(unsavedText(prompts.unsaved.outcome));
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeSettings();
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
        if (active && !prompts.busy && revision.current === version) {
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

  // While connected, sharing history, idle and in the foreground, compaction may run as background
  // model work. Any change here or a new submission stops it.
  const sessionId = session?.id;
  const direct = session?.chatgpt;
  const contextWindow = session?.contextWindow ?? null;
  useEffect(() => {
    if (!sessionId || !shareHistory || pending) return;
    const budget = contextBudget(contextWindow);
    const live = { id: sessionId, contextWindow, chatgpt: direct };
    const compactWhenIdle = () =>
      compactor.start(signal => {
        const model = connectedModel(pairingCode, live, undefined, signal, true);
        return conversation.compactIdle(
          async (...input) => {
            try {
              return await model(...input);
            } catch (error) {
              if (direct) await recoverChatGPTConnection(sessionId);
              throw error;
            }
          },
          budget,
          signal,
        );
      });
    if (AppState.currentState === 'active') compactWhenIdle();
    const subscription = AppState.addEventListener('change', state =>
      state === 'active' ? compactWhenIdle() : compactor.stop(),
    );
    return () => {
      subscription.remove();
      compactor.stop();
    };
  }, [sessionId, direct, contextWindow, shareHistory, pending, pairingCode]);

  function handle(operation: () => Promise<Task | null | void>) {
    if (prompts.busy) return;
    revision.current++;
    setStatus('');
    return exclusive(operation)?.then(
      snapshot => {
        if (snapshot) updateTask(snapshot);
      },
      error =>
        setStatus(
          error instanceof Error
            ? error.message
            : 'Could not complete the request.',
        ),
    );
  }

  function connect(signIn: boolean) {
    return handle(async () => {
      compactor.report(undefined);
      const code = pairingCode.trim();
      const scope = config.scope?.owner.startsWith('chatgpt:')
        ? config.scope
        : undefined;
      await settings.save({ pairingCode, shareHistory: false, scope });
      const bridge = companion(code);
      const connection = await (signIn ? bridge.signIn() : bridge.check());
      if (connection.ready && connection.sessionId) {
        await settings.save({
          pairingCode,
          shareHistory: false,
          scope,
          session: {
            id: connection.sessionId,
            contextWindow: connection.contextWindow ?? null,
          },
        });
      }
      setAnswer(
        connection.error ??
          (connection.ready
            ? connection.sessionId
              ? connection.contextWindow
                ? ''
                : `The companion did not report the model's context window. Saved conversation is budgeted for ${fallbackContextTokens.toLocaleString(
                    'en-US',
                  )} tokens.`
              : 'Restart the companion with the current build.'
            : connection.signingIn
            ? 'Finish sign-in on the companion computer, then check the connection.'
            : 'Sign in with ChatGPT on the companion computer.'),
      );
    });
  }

  async function downloadSpeechModel() {
    setSpeechError('');
    setSpeechModel('downloading');
    try {
      await NativeTasks.installSpeechModel();
      setSpeechModel('ready');
    } catch (error) {
      setSpeechError(
        error instanceof Error ? error.message : 'Download failed. Try again.',
      );
      setSpeechModel('missing');
    }
  }

  function signInWithChatGPT() {
    return handle(async () => {
      compactor.report(undefined);
      setAnswer('');
      await settings.disconnect();
      let connection: Connection;
      setSigningIn(true);
      try {
        connection = await (account?.signedIn
          ? chatgpt.connect()
          : chatgpt.signIn());
      } finally {
        setSigningIn(false);
        setAccount(await chatgpt.status().catch(() => null));
      }
      await settings.save({
        ...(await settings.read()),
        shareHistory: false,
        session: {
          id: connection.account,
          contextWindow: connection.contextWindow,
          chatgpt: true,
        },
      });
      if (!connection.contextWindow) {
        setAnswer(
          `ChatGPT did not report the model's context window. Saved conversation is budgeted for ${fallbackContextTokens.toLocaleString(
            'en-US',
          )} tokens.`,
        );
      }
    });
  }

  function signOut() {
    return handle(async () => {
      compactor.stop();
      compactor.report(undefined);
      setAnswer('');
      await settings.disconnect();
      const confirmed = await chatgpt.signOut();
      setAccount(await chatgpt.status().catch(() => null));
      setAnswer(
        confirmed
          ? 'Signed out of ChatGPT.'
          : 'Signed out on this phone, but ChatGPT did not confirm the disconnection. Disconnect Android Agent in ChatGPT Settings.',
      );
    });
  }

  function askAgent() {
    const message = prompt.trim();
    const screen = shareScreen;
    setAnswer('');
    setShareScreen(false);
    setPrompt('');
    return handle(async () => {
      try {
        const { outcome, saved } = await ask(message, screen, agentTools);
        if (!saved) setAnswer(unsavedText(outcome));
      } catch (error) {
        setPrompt(message);
        throw error;
      }
      return tasks.read();
    });
  }

  const latest = history.slice().reverse();

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior="padding" style={styles.screen}>
          <ScrollView
            ref={scroll}
            contentContainerStyle={styles.content}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onContentSizeChange={() => {
              const newest = history[0]?.id;
              if (lastScrolledTurn.current === newest) return;
              lastScrolledTurn.current = newest;
              scroll.current?.scrollToEnd();
            }}
          >
            <Text style={styles.brand}>Android Agent</Text>
            {speechModel !== null && speechModel !== 'ready' && (
              <View style={styles.panel}>
                <Text style={styles.description}>
                  Download 487 MB once to use voice recognition offline. Setup
                  needs 1.2 GB of free space.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  style={styles.secondary}
                  disabled={speechModel === 'downloading'}
                  onPress={downloadSpeechModel}
                >
                  <Text style={styles.label}>
                    {speechModel === 'downloading'
                      ? 'Downloading and verifying offline speech…'
                      : 'Download offline speech'}
                  </Text>
                </Pressable>
                {speechError !== '' && (
                  <Text style={styles.description}>{speechError}</Text>
                )}
              </View>
            )}
            <View style={styles.panel}>
              {!connected && (
                <>
                  <Text style={styles.description}>
                    {account
                      ? `${
                          account.signedIn ? 'Signed in' : 'Sign in again'
                        } as ${account.email ?? 'your ChatGPT account'}.`
                      : 'Sign in with ChatGPT to use your plan on this phone.'}
                  </Text>
                  {signingIn ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => chatgpt.cancelSignIn().catch(() => {})}
                      style={styles.secondary}
                    >
                      <Text style={styles.label}>Cancel sign-in</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => {
                        signInWithChatGPT();
                      }}
                      style={styles.button}
                    >
                      <Text style={styles.buttonText}>
                        {account?.signedIn
                          ? 'Continue with ChatGPT'
                          : 'Sign in with ChatGPT'}
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
              {account?.signedIn && (connected ? direct : !signingIn) && (
                <>
                  {connected && (
                    <Text style={styles.description}>
                      Signed in as {account.email ?? 'your ChatGPT account'}.
                    </Text>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={signOut}
                    style={styles.secondary}
                  >
                    <Text style={styles.label}>Sign out of ChatGPT</Text>
                  </Pressable>
                </>
              )}
              {(!connected || !direct) && (
                <>
                  {!connected && (
                    <Text style={styles.detail}>
                      Or pair with the companion on your computer.
                    </Text>
                  )}
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
                      compactor.stop();
                      compactor.report(undefined);
                      setAnswer('');
                      settings
                        .save({
                          pairingCode: value,
                          shareHistory: false,
                          scope: config.scope,
                        })
                        .catch(() => {});
                    }}
                  />
                </>
              )}
              {!connected && (
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || pairingCode.length !== 32}
                    onPress={() => connect(true)}
                    style={[styles.secondary, styles.grow]}
                  >
                    <Text style={styles.label}>Sign in on companion</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || pairingCode.length !== 32}
                    onPress={() => connect(false)}
                    style={[styles.secondary, styles.grow]}
                  >
                    <Text style={styles.label}>Check connection</Text>
                  </Pressable>
                </View>
              )}
              {connected && (
                <>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel="Share earlier conversation"
                    accessibilityState={{
                      checked: shareHistory,
                      disabled: busy,
                    }}
                    disabled={busy}
                    onPress={() =>
                      settings
                        .save({ ...config, shareHistory: !shareHistory })
                        .catch(() => {})
                    }
                    style={[styles.secondary, shareHistory && styles.selected]}
                  >
                    <Text style={styles.label}>
                      {shareHistory ? '☑' : '☐'} Share earlier conversation with
                      this connection
                    </Text>
                  </Pressable>
                  <Text style={styles.detail}>
                    {shareHistory
                      ? 'Replies use the whole saved conversation until this connection ends.'
                      : `Replies remember turns ${
                          direct ? 'on this ChatGPT account' : 'in this session'
                        }, typed or spoken. Earlier turns stay on this phone.`}
                  </Text>
                </>
              )}
            </View>
            {earlier && (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  loadHistory(history[history.length - 1].id).catch(() =>
                    setAnswer('Could not load earlier turns.'),
                  )
                }
                style={styles.secondary}
              >
                <Text style={styles.label}>Show earlier</Text>
              </Pressable>
            )}
            {latest.map(turn => (
              <View key={turn.id} style={styles.turn}>
                <Text selectable style={[styles.message, styles.prompt]}>
                  {turn.prompt}
                </Text>
                <Text selectable style={styles.message}>
                  {turn.id === prompts.unsaved?.id && turn.status === 'RUNNING'
                    ? 'Result pending save.'
                    : turnText(turn)}
                </Text>
                {turn.tasks.flatMap(linked =>
                  linked.request.steps.map(step => (
                    <Text
                      key={`${linked.request.id}-${step.id}`}
                      style={styles.detail}
                    >
                      {`${step.id}: ${(task?.request.id === linked.request.id
                        ? task
                        : linked
                      ).states[step.id].phase.toLowerCase()}`}
                    </Text>
                  )),
                )}
              </View>
            ))}
            {task && (
              <View style={styles.panel}>
                <Text accessibilityRole="header" style={styles.label}>
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
                    style={styles.secondary}
                    onPress={() => handle(() => tasks.cancel(task.request.id))}
                  >
                    <Text style={styles.label}>Cancel remaining steps</Text>
                  </Pressable>
                )}
              </View>
            )}
            {!!answer && (
              <Text accessibilityLiveRegion="polite" style={styles.description}>
                {answer}
              </Text>
            )}
            {!!status && (
              <Text accessibilityLiveRegion="polite" style={styles.description}>
                {status}
              </Text>
            )}
          </ScrollView>
          {connected && (
            <View style={styles.composer}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel="Share screen for this prompt"
                accessibilityState={{ checked: shareScreen, disabled: busy }}
                disabled={busy}
                onPress={() => setShareScreen(value => !value)}
              >
                <Text style={styles.detail}>
                  {shareScreen ? '☑' : '☐'} Allow the agent to open an installed
                  app and share its visible text and controls with ChatGPT for
                  this prompt
                </Text>
              </Pressable>
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel="Agent prompt"
                  placeholder="What should Android do?"
                  placeholderTextColor="#A4AB9B"
                  style={[styles.input, styles.grow]}
                  multiline
                  maxLength={2_000}
                  editable={!busy}
                  value={prompt}
                  onChangeText={value => {
                    setPrompt(value);
                    setShareScreen(false);
                  }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Run prompt"
                  disabled={busy || !prompt.trim()}
                  onPress={() => {
                    askAgent();
                  }}
                  style={styles.button}
                >
                  <Text style={styles.buttonText}>Send</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => handle(tasks.openAccessibilitySettings)}
              >
                <Text style={styles.detail}>
                  Screen sharing needs Android Agent window verification in
                  Accessibility settings.
                </Text>
              </Pressable>
            </View>
          )}
        </KeyboardAvoidingView>
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
    maxWidth: 560,
    alignSelf: 'center',
    padding: 20,
    gap: 16,
  },
  brand: { color: '#C9F37B', fontSize: 16, fontWeight: '600' },
  description: { color: '#C5C9BD', fontSize: 15, lineHeight: 22 },
  detail: { color: '#A4AB9B', fontSize: 13, lineHeight: 18 },
  panel: {
    backgroundColor: '#22251E',
    borderColor: '#3B4133',
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 12,
  },
  turn: { gap: 8 },
  message: {
    color: '#FBFAF4',
    fontSize: 16,
    lineHeight: 23,
    backgroundColor: '#22251E',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: 'flex-start',
    maxWidth: '88%',
  },
  prompt: { backgroundColor: '#3A472D', alignSelf: 'flex-end' },
  composer: {
    borderTopWidth: 1,
    borderColor: '#3B4133',
    padding: 12,
    gap: 8,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  grow: { flex: 1, maxHeight: 140 },
  secondary: {
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
  selected: { backgroundColor: '#3A472D', borderColor: '#C9F37B' },
  label: { color: '#FBFAF4', fontSize: 15, fontWeight: '600' },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#C9F37B',
    borderRadius: 14,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  buttonText: { color: '#19220F', fontSize: 16, fontWeight: '700' },
});
