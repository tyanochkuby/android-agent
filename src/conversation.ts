import {
  contextBudget,
  finishMessage,
  instructions,
  requestSize,
} from './agent';
import type { Message, Model } from './agent';
import NativeTasks from './native/NativeTasks';
import { tasks } from './tasks';
import type { Task } from './tasks';

export type Turn = {
  id: string;
  prompt: string;
  reply: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  detail: string | null;
  tasks: Task[];
};

type StoredTurn = Omit<Turn, 'tasks'> & { taskIds: string[] };
type Completed = Pick<Turn, 'id' | 'prompt' | 'reply'>;
type Checkpoint = { summary: string; covers: string };

export type Outcome = { reply: string } | { failure: string };

const summaryHeading = 'Summary of earlier conversation turns:\n';
const summaryRequest = `Summarize the conversation above, including any earlier summary, so the summary can replace it. Keep names, facts, preferences, decisions and outcomes the user may refer to later. Do not call Android tools. Reply with only a finish call whose message is the summary, at most 2,000 characters.`;

async function readTurns(limit: number, before: string | null = null) {
  const turns: StoredTurn[] = JSON.parse(
    await NativeTasks.readConversation(before, limit),
  );
  return turns;
}

export const conversation = {
  // Pages through turns newest first, with the tasks each turn submitted; pass the last turn ID as `before` for the next page.
  async read(limit: number, before: string | null = null): Promise<Turn[]> {
    const turns = await readTurns(limit, before);
    return Promise.all(
      turns.map(async ({ taskIds, ...turn }) => {
        const linked = await Promise.all(
          taskIds.map(id => tasks.read(id).catch(() => null)),
        );
        return { ...turn, tasks: linked.filter(task => task !== null) };
      }),
    );
  },
  // Saves the prompt as a running turn and returns its ID.
  start: (prompt: string, recoverUnacknowledged: boolean) =>
    NativeTasks.startTurn(prompt, recoverUnacknowledged),
  // Returns model input from completed turns: the checkpoint, then exact turns after its coverage.
  // Near the budget it first summarizes that input through `model` and switches to the saved summary.
  async context(model: Model, budget = contextBudget): Promise<Message[]> {
    const limit = budget.requestLimit - budget.headroom;
    const saved = await NativeTasks.readCheckpoint();
    let checkpoint: Checkpoint | null =
      saved === null ? null : JSON.parse(saved);
    let read = await uncovered(checkpoint, limit);
    if (
      !read.complete ||
      requestSize(prefix(checkpoint, read.turns)) > budget.compactAt
    ) {
      const next = await compact(model, checkpoint, read.turns, budget);
      if (next) {
        checkpoint = next;
        read = await uncovered(checkpoint, limit);
      }
    }
    // Past the limit, send the newest turns that fit without moving the checkpoint.
    const turns = read.complete ? read.turns : await newest(checkpoint, limit);
    return prefix(checkpoint, turns);
  },
  // Saves the outcome of a running turn. Retrying after a rejected or unacknowledged save is safe:
  // a save that already landed succeeds again.
  finish: (id: string, outcome: Outcome) =>
    'reply' in outcome
      ? NativeTasks.completeTurn(id, outcome.reply)
      : NativeTasks.failTurn(id, outcome.failure.slice(0, 2_000)),
};

function prefix(checkpoint: Checkpoint | null, turns: Completed[]): Message[] {
  return [
    ...(checkpoint
      ? [
          {
            role: 'user' as const,
            content: summaryHeading + checkpoint.summary,
          },
        ]
      : []),
    ...turns.flatMap<Message>(({ prompt, reply }) => [
      { role: 'user', content: prompt },
      { role: 'assistant', content: reply ?? '' },
    ]),
  ];
}

// Reads completed turns after the checkpoint, oldest first, while the prefix fits in `limit`.
async function uncovered(checkpoint: Checkpoint | null, limit: number) {
  const turns: Completed[] = [];
  let after = checkpoint?.covers ?? null;
  for (;;) {
    const page: Completed[] = JSON.parse(
      await NativeTasks.readCompletedTurns(after, 20),
    );
    for (const turn of page) {
      if (requestSize(prefix(checkpoint, [...turns, turn])) > limit) {
        return { turns, complete: false };
      }
      turns.push(turn);
    }
    if (page.length < 20) return { turns, complete: true };
    after = page[page.length - 1].id;
  }
}

// Reads the newest completed turns after the checkpoint that fit in `limit`, oldest first.
async function newest(checkpoint: Checkpoint | null, limit: number) {
  const turns: Completed[] = [];
  let before: string | null = null;
  for (;;) {
    const page = await readTurns(20, before);
    for (const turn of page) {
      if (checkpoint && BigInt(turn.id) <= BigInt(checkpoint.covers)) {
        return turns;
      }
      if (turn.status !== 'COMPLETED') continue;
      if (requestSize(prefix(checkpoint, [turn, ...turns])) > limit) {
        return turns;
      }
      turns.unshift(turn);
    }
    if (page.length < 20) return turns;
    before = page[page.length - 1].id;
  }
}

// Asks for a summary of the same prefix and saves it with its coverage. Returns null and keeps the
// current checkpoint when the reply is not a lone finish call or saving fails. Never runs tools.
async function compact(
  model: Model,
  checkpoint: Checkpoint | null,
  turns: Completed[],
  budget: typeof contextBudget,
): Promise<Checkpoint | null> {
  const input: Message[] = [
    ...prefix(checkpoint, turns),
    { role: 'user', content: summaryRequest },
  ];
  if (!turns.length || requestSize(input) > budget.requestLimit) return null;
  try {
    const summary = finishMessage(await model(instructions, input));
    if (!summary) return null;
    const next = { summary, covers: turns[turns.length - 1].id };
    await NativeTasks.saveCheckpoint(next.summary, next.covers);
    return next;
  } catch {
    return null;
  }
}
