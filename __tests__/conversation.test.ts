jest.mock('../src/native/NativeTasks', () => ({
  __esModule: true,
  default: {
    readConversation: jest.fn(),
    readCompletedTurns: jest.fn(),
    readCheckpoint: jest.fn(),
    saveCheckpoint: jest.fn(),
  },
}));

import NativeTasks from '../src/native/NativeTasks';
import { conversation } from '../src/conversation';
import { instructions, requestSize, runAgent } from '../src/agent';
import type { AgentTools, Message } from '../src/agent';

type Stored = {
  id: string;
  prompt: string;
  reply: string | null;
  status: string;
  detail: null;
  taskIds: string[];
};

let turns: Stored[] = [];
let checkpoints: { summary: string; covers: string }[] = [];

const add = (count: number, status = 'COMPLETED') => {
  for (let i = 0; i < count; i++) {
    const id = String(turns.length + 1);
    turns.push({
      id,
      prompt: `Prompt ${id} ${'x'.repeat(200)}`,
      reply: status === 'COMPLETED' ? `Reply ${id}` : null,
      status,
      detail: null,
      taskIds: [],
    });
  }
};

const summarize = (summary = 'Earlier: user owns a dog named Rex.') =>
  jest.fn(async (_: string, input: Message[]) =>
    input[input.length - 1].content.startsWith('Summarize')
      ? JSON.stringify([{ tool: 'finish', message: summary }])
      : JSON.stringify([{ tool: 'finish', message: 'unused' }]),
  );

// Each stored turn adds roughly 280 characters to the request.
const base = requestSize([]);
const budget = {
  requestLimit: base + 5_000,
  headroom: 2_000,
  compactAt: base + 2_000,
};

beforeEach(() => {
  jest.clearAllMocks();
  turns = [];
  checkpoints = [];
  jest
    .mocked(NativeTasks.readConversation)
    .mockImplementation(async (before, limit) =>
      JSON.stringify(
        turns
          .filter(turn => before === null || Number(turn.id) < Number(before))
          .reverse()
          .slice(0, limit),
      ),
    );
  jest
    .mocked(NativeTasks.readCompletedTurns)
    .mockImplementation(async (after, limit) =>
      JSON.stringify(
        turns
          .filter(
            turn =>
              turn.status === 'COMPLETED' &&
              Number(turn.id) > Number(after ?? 0),
          )
          .slice(0, limit),
      ),
    );
  jest
    .mocked(NativeTasks.readCheckpoint)
    .mockImplementation(async () =>
      checkpoints.length
        ? JSON.stringify(checkpoints[checkpoints.length - 1])
        : null,
    );
  jest
    .mocked(NativeTasks.saveCheckpoint)
    .mockImplementation(async (summary, covers) => {
      checkpoints.push({ summary, covers });
    });
});

test('normal turns extend the previous input as a prefix', async () => {
  const model = summarize();
  add(1);
  add(1, 'FAILED');
  add(1);
  const first = await conversation.context(model, budget);
  add(1, 'INTERRUPTED');
  add(1);
  const second = await conversation.context(model, budget);

  expect(first.map(message => message.content)).toEqual([
    turns[0].prompt,
    'Reply 1',
    turns[2].prompt,
    'Reply 3',
  ]);
  expect(second.slice(0, first.length)).toEqual(first);
  expect(second).toHaveLength(6);
  expect(model).not.toHaveBeenCalled();
});

test('compaction appends its request to the same prefix and switches to the saved checkpoint', async () => {
  const model = summarize();
  add(8);
  const before = await conversation.context(model, {
    ...budget,
    compactAt: Infinity,
  });
  add(5);
  const after = await conversation.context(model, budget);

  expect(model).toHaveBeenCalledTimes(1);
  const request = model.mock.calls[0][1];
  expect(request.slice(0, before.length)).toEqual(before);
  expect(request[request.length - 1].content).toMatch(/^Summarize/);
  const covers = turns[(request.length - 1) / 2 - 1].id;
  expect(checkpoints).toEqual([
    { summary: 'Earlier: user owns a dog named Rex.', covers },
  ]);
  expect(after[0].content).toContain('user owns a dog named Rex');
  expect(after[1].content).toBe(turns[Number(covers)].prompt);
  expect(after.length).toBe(1 + 2 * (turns.length - Number(covers)));

  // A later turn reuses the checkpoint without summarizing again.
  add(1);
  const next = await conversation.context(model, budget);
  expect(next.slice(0, after.length)).toEqual(after);
  expect(model).toHaveBeenCalledTimes(1);
});

const prefixOf = (checkpoint: string, from: number) => [
  {
    role: 'user',
    content: `Summary of earlier conversation turns:\n${checkpoint}`,
  },
  ...turns.slice(from).flatMap(turn => [
    { role: 'user', content: turn.prompt },
    { role: 'assistant', content: turn.reply },
  ]),
];

test.each([
  ['the model fails', () => jest.fn().mockRejectedValue(new Error('offline'))],
  [
    'the reply runs a tool',
    () => jest.fn().mockResolvedValue(JSON.stringify([{ tool: 'observe_ui' }])),
  ],
  ['the reply is not valid', () => jest.fn().mockResolvedValue('not json')],
])(
  'keeps the previous checkpoint without saving when %s',
  async (_, makeModel) => {
    checkpoints = [{ summary: 'Earlier summary.', covers: '2' }];
    add(10);
    const model = makeModel();
    const input = await conversation.context(model, budget);

    expect(model).toHaveBeenCalledTimes(1);
    expect(NativeTasks.saveCheckpoint).not.toHaveBeenCalled();
    expect(input).toEqual(prefixOf('Earlier summary.', 2));
  },
);

test('keeps the previous checkpoint when saving is rejected', async () => {
  jest.mocked(NativeTasks.saveCheckpoint).mockRejectedValue(new Error('older'));
  checkpoints = [{ summary: 'Earlier summary.', covers: '2' }];
  add(10);
  const input = await conversation.context(summarize(), budget);

  expect(NativeTasks.saveCheckpoint).toHaveBeenCalledTimes(1);
  expect(checkpoints).toEqual([{ summary: 'Earlier summary.', covers: '2' }]);
  expect(input).toEqual(prefixOf('Earlier summary.', 2));
});

test('skips summarizing when the summary request itself is over the limit', async () => {
  add(10);
  const model = summarize();
  const input = await conversation.context(model, {
    ...budget,
    requestLimit: budget.compactAt,
    headroom: -budget.requestLimit,
  });

  expect(model).not.toHaveBeenCalled();
  expect(input).toHaveLength(20);
});

test('past the hard limit without a summary, sends the newest turns that fit', async () => {
  const model = jest.fn().mockRejectedValue(new Error('offline'));
  add(30);
  const input = await conversation.context(model, budget);

  expect(requestSize(input)).toBeLessThanOrEqual(
    budget.requestLimit - budget.headroom,
  );
  expect(input[input.length - 1].content).toBe('Reply 30');
  expect(input[0].content).not.toBe(turns[0].prompt);
});

test('context starts from a stored checkpoint without summarizing again', async () => {
  checkpoints = [{ summary: 'User owns a dog named Rex.', covers: '3' }];
  add(4);
  const model = summarize();
  const input = await conversation.context(model, budget);

  expect(input.map(message => message.content)).toEqual([
    'Summary of earlier conversation turns:\nUser owns a dog named Rex.',
    turns[3].prompt,
    'Reply 4',
  ]);
  expect(model).not.toHaveBeenCalled();
});

test('successive model calls reuse the previous request as a prefix, across compaction', async () => {
  const calls: Message[][] = [];
  const model = jest.fn(async (system: string, input: Message[]) => {
    expect(system).toBe(instructions);
    calls.push(input);
    const last = input[input.length - 1].content;
    return JSON.stringify([
      {
        tool: 'finish',
        message: last.startsWith('Summarize')
          ? 'Summary of everything.'
          : `Answer to ${last.slice(0, 8)}`,
      },
    ]);
  });
  const tools = {} as AgentTools;
  // Stands in for App: save the prompt, build context, run, save the reply.
  async function ask(prompt: string) {
    const input = await conversation.context(model, budget);
    const reply = await runAgent(prompt, model, tools, false, input);
    turns.push({
      id: String(turns.length + 1),
      prompt,
      reply,
      status: 'COMPLETED',
      detail: null,
      taskIds: [],
    });
  }

  for (let i = 0; i < 12; i++) await ask(`Prompt ${i} ${'x'.repeat(200)}`);

  const summary = calls.findIndex(input =>
    input[input.length - 1].content.startsWith('Summarize'),
  );
  expect(summary).toBeGreaterThan(0);
  // Every request extends the previous one, including the summary request, except the first after compaction.
  calls.forEach((input, i) => {
    expect(requestSize(input)).toBeLessThanOrEqual(budget.requestLimit);
    if (i === 0 || i === summary + 1) return;
    expect(input.slice(0, calls[i - 1].length)).toEqual(calls[i - 1]);
  });
  expect(calls[summary + 1]).toEqual([
    {
      role: 'user',
      content: 'Summary of earlier conversation turns:\nSummary of everything.',
    },
    { role: 'user', content: expect.stringMatching(/^Prompt \d+ /) },
  ]);
});
