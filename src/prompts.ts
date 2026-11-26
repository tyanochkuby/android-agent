import { contextBudget, runAgent } from './agent';
import type { AgentTools, Model } from './agent';
import { chatgpt } from './chatgpt';
import { companion } from './companion';
import { conversation } from './conversation';
import type { Outcome } from './conversation';
import { idleCompactor } from './idleCompaction';
import { settings } from './settings';
import type { Session } from './settings';

// One runtime-wide queue of one: typed prompts, voice prompts and the screen's other requests
// share it, so a voice turn finds the screen busy and the other way round. State lives at module
// level so in-flight work survives a remounted screen or a closed Activity.
let current: Promise<unknown> | null = null;
let startAttempt: string | null = null;
let unsaved: { id: string; outcome: Outcome } | null = null;
const listeners = new Set<() => void>();

export const compactor = idleCompactor();

export const prompts = {
  get busy() {
    return current !== null;
  },
  // An outcome whose save failed. It is saved again before the next prompt starts.
  get unsaved() {
    return unsaved;
  },
  // `listener` runs when work starts, when a prompt is saved and when work settles.
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

function changed() {
  listeners.forEach(listener => listener());
}

// Runs `operation` unless other work is running, and returns undefined when it is.
export function exclusive<T>(operation: () => Promise<T>) {
  if (current) return undefined;
  compactor.stop();
  const run = Promise.resolve()
    .then(operation)
    .finally(() => {
      current = null;
      changed();
    });
  current = run;
  changed();
  return run;
}

// The model of `session`. With `live`, the request is background work that `live` aborts; on the
// companion it then runs only on an already open model connection.
export function connectedModel(
  pairingCode: string,
  session: Session,
  onUsage?: (inputTokens: number | undefined) => void,
  live?: AbortSignal,
): Model {
  if (session.chatgpt) return chatgpt.model(session.id, onUsage, live);
  const bridge = companion(pairingCode.trim(), session.id, onUsage);
  return live ? bridge.liveModel(live) : bridge.model;
}

// A ChatGPT account keeps its history across reconnects. A companion session does not: the
// companion's account is unknown, and pairing again drops the scope.
function historyOwner(session: Session) {
  return `${session.chatgpt ? 'chatgpt' : 'companion'}:${session.id}`;
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

// Saves `message` as a running turn, runs the agent on the saved connection and saves
// the reply or failure against the turn. Rejects only when the prompt could not be saved; the
// turn is never retried. `tools` receives the turn ID. Call inside `exclusive`.
export async function ask(
  message: string,
  shareScreen: boolean,
  tools: (turn: string) => AgentTools,
) {
  compactor.report(undefined);
  let config = await settings.read();
  if (unsaved) await save(unsaved.id, unsaved.outcome);
  const owner = config.session && historyOwner(config.session);
  if (owner && config.scope?.owner !== owner) {
    config = {
      ...config,
      scope: { owner, since: await conversation.latestId() },
    };
    await settings.save(config);
  }
  // Starting succeeds only when no turn is running, so an outcome still unsaved here is stale.
  const attempt = (startAttempt ??= `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`);
  const id = await conversation.start(message, attempt);
  startAttempt = null;
  unsaved = null;
  changed();

  let outcome: Outcome;
  try {
    const { session, shareHistory, scope } = config;
    if (!session || !scope) {
      throw new Error('Sign in with ChatGPT in Android Agent.');
    }
    const budget = contextBudget(session.contextWindow);
    const model = connectedModel(config.pairingCode, session, compactor.report);
    outcome = {
      reply: await runAgent(
        message,
        model,
        tools(id),
        shareScreen,
        shareHistory
          ? await conversation.context(model, budget)
          : await conversation.since(scope.since, budget),
        budget,
      ),
    };
  } catch (error) {
    compactor.report(undefined);
    // Like a failed typed prompt, any failure ends the connection and its history consent.
    if (config.session) await settings.disconnect().catch(() => {});
    outcome = {
      failure:
        (error instanceof Error && error.message.trim()) ||
        'The agent stopped.',
    };
  }
  return { turn: id, outcome, saved: await save(id, outcome) };
}
