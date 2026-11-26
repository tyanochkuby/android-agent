import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import App from '../App';
import NativeTasks from '../src/native/NativeTasks';
import type { TaskRequest } from '../src/tasks';
import * as companionModule from '../src/companion';
import { companion } from '../src/companion';
import { instructions } from '../src/agent';
import type { Model } from '../src/agent';
import { idleDelayMs } from '../src/idleCompaction';
import { voiceTurn } from '../src/voice';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('../src/native/NativeTasks', () => ({
  __esModule: true,
  default: {
    submit: jest.fn(),
    read: jest.fn(),
    resume: jest.fn(),
    cancel: jest.fn(),
    openAccessibilitySettings: jest.fn(),
    waitForTask: jest.fn(),
    readConversation: jest.fn(),
    readCompletedTurns: jest.fn(),
    readCheckpoint: jest.fn(),
    saveCheckpoint: jest.fn(),
    startTurn: jest.fn(),
    completeTurn: jest.fn(),
    failTurn: jest.fn(),
    readSettings: jest.fn(),
    saveSettings: jest.fn(),
    finishVoiceTurn: jest.fn(),
    speechModelStatus: jest.fn(async () => null),
    chatgptStatus: jest.fn(async () => null),
    chatgptSignIn: jest.fn(),
    chatgptCancelSignIn: jest.fn(),
    chatgptConnect: jest.fn(),
    chatgptSignOut: jest.fn(),
    chatgptRespond: jest.fn(),
  },
}));

const submit = jest.mocked(NativeTasks.submit);
const read = jest.mocked(NativeTasks.read);
const resume = jest.mocked(NativeTasks.resume);

type StoredTurn = {
  id: string;
  prompt: string;
  reply: string | null;
  status: string;
  detail: string | null;
  taskIds: string[];
  owner?: string | null;
};
let turns: StoredTurn[];

function finish(status: string, field: 'reply' | 'detail') {
  return async (id: string, text: string) => {
    const turn = turns.find(saved => saved.id === id)!;
    // Like the native store, repeating a save that already landed succeeds.
    if (turn.status === status && turn[field] === text) return;
    if (turn.status !== 'RUNNING') throw new Error('No longer running.');
    Object.assign(turn, { status, [field]: text });
  };
}

let storedSettings: string | null;

beforeEach(() => {
  storedSettings = null;
  jest
    .mocked(NativeTasks.readSettings)
    .mockImplementation(async () => storedSettings);
  jest.mocked(NativeTasks.saveSettings).mockImplementation(async value => {
    storedSettings = value;
  });
  submit.mockReset();
  read.mockReset();
  resume.mockReset();
  read.mockResolvedValue(null);
  turns = [];
  jest
    .mocked(NativeTasks.readConversation)
    .mockImplementation(async (before, limit) => {
      const older = turns.filter(
        turn => before === null || Number(turn.id) < Number(before),
      );
      return JSON.stringify(older.reverse().slice(0, limit));
    });
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
  jest.mocked(NativeTasks.readCheckpoint).mockResolvedValue(null);
  jest
    .mocked(NativeTasks.startTurn)
    .mockImplementation(async (prompt, _attempt, owner) => {
      if (turns.some(turn => turn.status === 'RUNNING')) {
        throw new Error('Finish the current prompt first.');
      }
      const id = String(turns.length + 1);
      turns.push({
        id,
        prompt,
        owner,
        reply: null,
        status: 'RUNNING',
        detail: null,
        taskIds: [],
      });
      return id;
    });
  jest
    .mocked(NativeTasks.completeTurn)
    .mockImplementation(finish('COMPLETED', 'reply'));
  jest
    .mocked(NativeTasks.failTurn)
    .mockImplementation(finish('FAILED', 'detail'));
});

async function connectCompanion(model: jest.Mock) {
  const bridge = jest.spyOn(require('../src/companion'), 'companion');
  bridge.mockReturnValue({
    signIn: jest.fn(),
    check: jest
      .fn()
      .mockResolvedValue({ ready: true, sessionId: 'test-session' }),
    model,
    liveModel: jest.fn(),
  } satisfies ReturnType<typeof companion>);
  await fireEvent.changeText(
    screen.getByLabelText('Companion pairing code'),
    'a'.repeat(32),
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Check connection' }),
  );
  await fireEvent.press(
    screen.getByRole('checkbox', { name: 'Share earlier conversation' }),
  );
  return bridge;
}

async function ask(prompt: string) {
  await fireEvent.changeText(screen.getByLabelText('Agent prompt'), prompt);
  await fireEvent.press(screen.getByRole('button', { name: 'Run prompt' }));
}

test('a paused task requires an explicit continuation', async () => {
  const request: TaskRequest = {
    id: 'restored',
    steps: [{ id: 'timer', action: { type: 'clock.startTimer', seconds: 60 } }],
  };
  read.mockResolvedValue(
    JSON.stringify({ request, states: { timer: { phase: 'PAUSED' } } }),
  );
  resume.mockResolvedValue(
    JSON.stringify({ request, states: { timer: { phase: 'ISSUED' } } }),
  );

  await render(<App />);
  expect(resume).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue task' }));
  expect(resume).toHaveBeenCalledWith('restored');
});

test('shows a request error and allows another request', async () => {
  const request: TaskRequest = {
    id: 'restored',
    steps: [{ id: 'timer', action: { type: 'clock.startTimer', seconds: 60 } }],
  };
  read.mockResolvedValue(
    JSON.stringify({ request, states: { timer: { phase: 'PAUSED' } } }),
  );
  resume.mockRejectedValueOnce(new Error('Could not resume the task.'));
  resume.mockResolvedValue(
    JSON.stringify({ request, states: { timer: { phase: 'ISSUED' } } }),
  );

  await render(<App />);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue task' }));
  expect(screen.getByText('Could not resume the task.')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Continue task' }));
  expect(resume).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Could not resume the task.')).toBeNull();
});

test('foreground events share an in-flight status read', async () => {
  const subscribe = jest.mocked(AppState.addEventListener);
  let finishRead: (value: null) => void = () => {};
  read.mockReturnValueOnce(
    new Promise(resolve => {
      finishRead = resolve;
    }),
  );

  await render(<App />);
  const onAppStateChanged = subscribe.mock.lastCall![1];
  await act(async () => {
    onAppStateChanged('background');
    onAppStateChanged('active');
    onAppStateChanged('active');
    expect(read).toHaveBeenCalledTimes(1);
    finishRead(null);
  });
  await act(async () => {
    onAppStateChanged('active');
  });
  expect(read).toHaveBeenCalledTimes(2);
});

test('shows recovered window evidence alongside an unknown launch outcome', async () => {
  read.mockResolvedValue(
    JSON.stringify({
      request: { id: 'restored', steps: [{ id: 'open' }] },
      states: {
        open: {
          phase: 'UNKNOWN',
          result: { type: 'window', app: 'MAPS', active: true, observedAt: 1 },
        },
      },
    }),
  );

  await render(<App />);
  expect(
    screen.getByText('open: unknown · Google Maps was active during recovery'),
  ).toBeTruthy();
});

test('starts companion sign-in and runs a prompt once plan usage is enabled', async () => {
  const bridge = jest.spyOn(require('../src/companion'), 'companion');
  const signIn = jest.fn().mockResolvedValue({ signingIn: true });
  const check = jest
    .fn()
    .mockResolvedValue({ ready: true, sessionId: 'test-session' });
  const model = jest
    .fn()
    .mockResolvedValue(
      '[{"tool":"finish","message":"Ready for Android tasks."}]',
    );
  bridge.mockReturnValue({
    signIn,
    check,
    model,
    liveModel: jest.fn(),
  } satisfies ReturnType<typeof companion>);
  try {
    await render(<App />);
    await fireEvent.changeText(
      screen.getByLabelText('Companion pairing code'),
      'a'.repeat(32),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in on companion' }),
    );
    expect(
      screen.getByText(/Finish sign-in on the companion computer/),
    ).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Check connection' }),
    );
    await fireEvent.changeText(
      screen.getByLabelText('Agent prompt'),
      'What can you do?',
    );
    expect(
      screen.getByRole('checkbox', { name: 'Share screen for this prompt' })
        .props.accessibilityState.checked,
    ).toBe(false);
    await fireEvent.press(
      screen.getByRole('checkbox', { name: 'Share screen for this prompt' }),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Run prompt' }));
    expect(
      screen.getByRole('checkbox', { name: 'Share screen for this prompt' })
        .props.accessibilityState.checked,
    ).toBe(false);
    expect(screen.getByText('Ready for Android tasks.')).toBeTruthy();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledWith(expect.any(String), [
      { role: 'user', content: 'What can you do?' },
      { role: 'user', content: expect.stringContaining('observe_ui') },
    ]);
  } finally {
    bridge.mockRestore();
  }
});

test('signs in with ChatGPT on the phone and answers on that account', async () => {
  jest.mocked(NativeTasks.chatgptSignIn).mockImplementation(async () => {
    jest
      .mocked(NativeTasks.chatgptStatus)
      .mockResolvedValue(
        JSON.stringify({ account: 'user-1', email: 'a@b.c', signedIn: true }),
      );
    return JSON.stringify({
      account: 'user-1',
      email: 'a@b.c',
      contextWindow: 272_000,
    });
  });
  jest.mocked(NativeTasks.chatgptRespond).mockResolvedValue(
    JSON.stringify({
      text: '[{"tool":"finish","message":"Hello from ChatGPT."}]',
      inputTokens: 1200,
    }),
  );
  jest.mocked(NativeTasks.chatgptSignOut).mockImplementation(async () => {
    jest.mocked(NativeTasks.chatgptStatus).mockResolvedValue(null);
    return 'false';
  });
  try {
    await render(<App />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
    );
    expect(screen.getByText('Signed in as a@b.c.')).toBeTruthy();
    expect(screen.queryByLabelText('Companion pairing code')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Agent prompt'), 'Hi');
    await fireEvent.press(screen.getByRole('button', { name: 'Run prompt' }));
    expect(screen.getByText('Hello from ChatGPT.')).toBeTruthy();
    expect(NativeTasks.chatgptRespond).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      expect.stringContaining('"content":"Hi"'),
      false,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign out of ChatGPT' }),
    );
    expect(
      screen.getByText(/Disconnect Android Agent in ChatGPT Settings/),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Agent prompt')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
    ).toBeTruthy();
  } finally {
    jest.mocked(NativeTasks.chatgptStatus).mockResolvedValue(null);
  }
});

test('reports a cancelled ChatGPT sign-in and stays signed out', async () => {
  let fail!: (error: Error) => void;
  jest
    .mocked(NativeTasks.chatgptSignIn)
    .mockImplementation(() => new Promise((_, reject) => (fail = reject)));
  jest
    .mocked(NativeTasks.chatgptCancelSignIn)
    .mockImplementation(async () => fail(new Error('Sign-in was cancelled.')));
  await render(<App />);
  await fireEvent.press(
    screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel sign-in' }));
  expect(screen.getByText('Sign-in was cancelled.')).toBeTruthy();
  expect(screen.queryByLabelText('Agent prompt')).toBeNull();
  expect(JSON.parse(storedSettings!).session).toBeUndefined();
});

test('pairing again keeps history local until sharing is enabled', async () => {
  const model = jest
    .fn()
    .mockResolvedValue('[{"tool":"finish","message":"Saved reply."}]');
  await render(<App />);
  const bridge = await connectCompanion(model);
  try {
    await ask('Private history');
    await fireEvent.changeText(
      screen.getByLabelText('Companion pairing code'),
      'b'.repeat(32),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Check connection' }),
    );
    expect(screen.getByText('Private history')).toBeTruthy();
    await ask('New prompt');
    expect(model).toHaveBeenLastCalledWith(expect.any(String), [
      { role: 'user', content: 'New prompt' },
    ]);
  } finally {
    bridge.mockRestore();
  }
});

describe('history without sharing', () => {
  const respond = jest.mocked(NativeTasks.chatgptRespond);

  function account(id: string) {
    const connection = { account: id, email: `${id}@b.c`, contextWindow: null };
    jest
      .mocked(NativeTasks.chatgptStatus)
      .mockResolvedValue(JSON.stringify({ ...connection, signedIn: true }));
    return JSON.stringify(connection);
  }

  function lastInput() {
    return JSON.parse(respond.mock.calls.at(-1)![2]);
  }

  beforeEach(() => {
    respond.mockReset();
    respond.mockImplementation(async (_, __, input) =>
      JSON.stringify({
        text: JSON.stringify([
          {
            tool: 'finish',
            message: `Re: ${JSON.parse(input).at(-1).content}`,
          },
        ]),
        inputTokens: null,
      }),
    );
    jest
      .mocked(NativeTasks.chatgptSignIn)
      .mockImplementation(async () => account('user-1'));
    jest
      .mocked(NativeTasks.chatgptConnect)
      .mockImplementation(async () => account('user-1'));
    jest.mocked(NativeTasks.chatgptSignOut).mockImplementation(async () => {
      jest.mocked(NativeTasks.chatgptStatus).mockResolvedValue(null);
      return 'true';
    });
  });

  afterEach(() => {
    jest.mocked(NativeTasks.chatgptStatus).mockResolvedValue(null);
  });

  test('a voice follow-up continues a typed turn but not turns saved before', async () => {
    turns = [
      {
        id: '1',
        prompt: 'Local only',
        reply: 'Kept here.',
        status: 'COMPLETED',
        detail: null,
        taskIds: [],
      },
    ];
    await render(<App />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Share earlier conversation' }).props
        .accessibilityState.checked,
    ).toBe(false);
    await ask('Can you see my screen?');
    await act(() => voiceTurn({ id: 'voice-1', transcript: 'And now?' }));

    expect(lastInput()).toEqual([
      { role: 'user', content: 'Can you see my screen?' },
      { role: 'assistant', content: 'Re: Can you see my screen?' },
      { role: 'user', content: 'And now?' },
    ]);
  });

  test("keeps an account's turns across a restart and reconnect, never for another account", async () => {
    const mounted = await render(<App />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
    );
    await ask('My dog is Rex.');
    respond.mockRejectedValueOnce(new Error('Network down.'));
    await ask('Hello');
    expect(JSON.parse(storedSettings!).session).toBeUndefined();
    const companionModel = jest
      .fn()
      .mockResolvedValue('[{"tool":"finish","message":"Companion reply."}]');
    const bridge = await connectCompanion(companionModel);
    try {
      await fireEvent.press(
        screen.getByRole('checkbox', { name: 'Share earlier conversation' }),
      );
      await ask('Companion-only prompt');
      companionModel.mockRejectedValueOnce(
        new Error('Companion disconnected.'),
      );
      await ask('Disconnect');
    } finally {
      bridge.mockRestore();
    }
    await fireEvent.press(
      screen.getByRole('button', { name: 'Continue with ChatGPT' }),
    );
    await mounted.unmount();

    await render(<App />);
    await ask('What is my dog called?');
    expect(lastInput()).toEqual([
      { role: 'user', content: 'My dog is Rex.' },
      { role: 'assistant', content: 'Re: My dog is Rex.' },
      { role: 'user', content: 'What is my dog called?' },
    ]);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign out of ChatGPT' }),
    );
    jest
      .mocked(NativeTasks.chatgptSignIn)
      .mockImplementation(async () => account('user-2'));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
    );
    await ask('Who am I?');
    expect(respond).toHaveBeenLastCalledWith(
      'user-2',
      expect.any(String),
      JSON.stringify([{ role: 'user', content: 'Who am I?' }]),
      false,
    );
  });
});

test('saves the prompt before inference and sends completed turns with a follow-up', async () => {
  turns = [
    {
      id: '1',
      prompt: 'Set a timer',
      reply: null,
      status: 'INTERRUPTED',
      detail: null,
      taskIds: [],
    },
  ];
  const statusDuringInference: string[] = [];
  const replies = ['Nice to meet Rex.', 'Your dog is Rex.'];
  const model = jest.fn(async () => {
    statusDuringInference.push(turns[turns.length - 1].status);
    return JSON.stringify([{ tool: 'finish', message: replies.shift() }]);
  });

  await render(<App />);
  expect(
    screen.getByText('Interrupted before a reply was saved.'),
  ).toBeTruthy();
  const bridge = await connectCompanion(model);
  try {
    await ask('My dog is Rex.');
    await ask('What is my dog called?');
  } finally {
    bridge.mockRestore();
  }

  expect(statusDuringInference).toEqual(['RUNNING', 'RUNNING']);
  expect(turns.map(({ status, reply }) => [status, reply])).toEqual([
    ['INTERRUPTED', null],
    ['COMPLETED', 'Nice to meet Rex.'],
    ['COMPLETED', 'Your dog is Rex.'],
  ]);
  expect(model.mock.calls[0]).toEqual([
    instructions,
    [{ role: 'user', content: 'My dog is Rex.' }],
  ]);
  expect(model.mock.calls[1]).toEqual([
    instructions,
    [
      { role: 'user', content: 'My dog is Rex.' },
      { role: 'assistant', content: 'Nice to meet Rex.' },
      { role: 'user', content: 'What is my dog called?' },
    ],
  ]);
  expect(screen.getByText('Your dog is Rex.')).toBeTruthy();
});

test('a remounted screen shows the reply when an in-flight prompt settles', async () => {
  let resolveReply!: (reply: string) => void;
  const model = jest.fn(
    () =>
      new Promise<string>(resolve => {
        resolveReply = resolve;
      }),
  );
  let commitPrompt!: () => void;
  const start = jest.mocked(NativeTasks.startTurn);
  const insert = start.getMockImplementation()!;
  start.mockImplementationOnce(
    (prompt, attempt, owner) =>
      new Promise(resolve => {
        commitPrompt = () => resolve(insert(prompt, attempt, owner));
      }),
  );
  const mounted = await render(<App />);
  const bridge = await connectCompanion(model);
  try {
    await ask('First prompt');
    await mounted.unmount();
    await render(<App />);
    expect(screen.queryByText('First prompt')).toBeNull();
    await act(async () => {
      commitPrompt();
    });
    expect(screen.getByText('First prompt')).toBeTruthy();
    expect(model).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Working…')).toBeTruthy();
    await act(async () => {
      resolveReply('[{"tool":"finish","message":"First reply."}]');
    });
    expect(screen.getByText('First reply.')).toBeTruthy();
    expect(screen.queryByText('Working…')).toBeNull();
    expect(model).toHaveBeenCalledTimes(1);
  } finally {
    bridge.mockRestore();
  }
});

test.each([
  ['is rejected', false],
  ['lands without an acknowledgement', true],
])('saves a reply again after remount when its save %s', async (_, lands) => {
  const replies = ['First reply.', 'Second reply.'];
  const model = jest.fn(async () =>
    JSON.stringify([{ tool: 'finish', message: replies.shift() }]),
  );
  const complete = jest.mocked(NativeTasks.completeTurn);
  complete.mockClear();
  const save = complete.getMockImplementation()!;
  complete.mockImplementationOnce(async (id, reply) => {
    if (lands) await save(id, reply);
    throw new Error('Storage busy.');
  });

  const mounted = await render(<App />);
  const bridge = await connectCompanion(model);
  try {
    await ask('First prompt');
    expect(screen.getByText(/Could not save this result/)).toBeTruthy();
    await mounted.unmount();
    // The connection is saved on the device, so the new screen is already connected.
    await render(<App />);
    await ask('Second prompt');
  } finally {
    bridge.mockRestore();
  }

  expect(complete.mock.calls).toEqual([
    ['1', 'First reply.'],
    ['1', 'First reply.'],
    ['2', 'Second reply.'],
  ]);
  expect(turns.map(({ status, reply }) => [status, reply])).toEqual([
    ['COMPLETED', 'First reply.'],
    ['COMPLETED', 'Second reply.'],
  ]);
  expect(model).toHaveBeenCalledTimes(2);
});

test('records a failed turn and links tasks submitted for it', async () => {
  const timer = {
    request: {
      id: 'timer-task',
      steps: [
        { id: 'timer', action: { type: 'clock.startTimer', seconds: 60 } },
      ],
    },
    states: { timer: { phase: 'ISSUED' } },
  };
  submit.mockImplementation(async (_, turn) => {
    turns.find(saved => saved.id === turn)!.taskIds.push('timer-task');
    return JSON.stringify(timer);
  });
  jest.mocked(NativeTasks.waitForTask).mockResolvedValue(JSON.stringify(timer));
  read.mockImplementation(async id =>
    id === 'timer-task' ? JSON.stringify(timer) : null,
  );
  const model = jest
    .fn()
    .mockResolvedValueOnce('[{"tool":"start_timer","seconds":60}]')
    .mockRejectedValueOnce(new Error('The companion did not reply.'));

  await render(<App />);
  const bridge = await connectCompanion(model);
  try {
    await ask('Start a one minute timer');
  } finally {
    bridge.mockRestore();
  }

  expect(submit).toHaveBeenCalledWith(expect.any(String), '1');
  expect(turns[0]).toMatchObject({
    status: 'FAILED',
    detail: 'The companion did not reply.',
    taskIds: ['timer-task'],
  });
  expect(screen.getAllByText('The companion did not reply.')).toHaveLength(1);
  expect(screen.getAllByText('timer: issued').length).toBeGreaterThan(0);
});

test('pages through earlier turns', async () => {
  turns = Array.from({ length: 21 }, (_, index) => ({
    id: String(index + 1),
    prompt: `Prompt ${index + 1}`,
    reply: `Reply ${index + 1}`,
    status: 'COMPLETED',
    detail: null,
    taskIds: [],
  }));

  await render(<App />);
  expect(screen.queryByText('Prompt 1')).toBeNull();
  expect(screen.getByText('Prompt 21')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Show earlier' }));
  expect(screen.getByText('Prompt 1')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show earlier' })).toBeNull();
});

describe('idle compaction', () => {
  let summaries: {
    signal: AbortSignal;
    input: Parameters<Model>[1];
    reply: (summary: string) => void;
  }[];

  // The preset's AppState mock reports no state; the app is in the foreground here.
  const mockedState = AppState.currentState;
  beforeEach(() => {
    jest.useFakeTimers();
    summaries = [];
    jest.mocked(NativeTasks.saveCheckpoint).mockReset();
    AppState.currentState = 'active';
  });
  afterEach(() => {
    jest.useRealTimers();
    AppState.currentState = mockedState;
  });

  // Idle summaries wait until the test replies.
  async function connect(...usage: (number | undefined)[]) {
    const bridge = jest.spyOn(companionModule, 'companion');
    bridge.mockImplementation((_, __, onUsage) => ({
      signIn: jest.fn(),
      check: jest
        .fn()
        .mockResolvedValue({ ready: true, sessionId: 'test-session' }),
      model: async () => {
        onUsage?.(usage.length > 1 ? usage.shift() : usage[0]);
        return '[{"tool":"finish","message":"Done."}]';
      },
      liveModel: (signal: AbortSignal) => (_instructions, input) =>
        new Promise<string>(resolve =>
          summaries.push({
            signal,
            input,
            reply: summary =>
              resolve(JSON.stringify([{ tool: 'finish', message: summary }])),
          }),
        ),
    }));
    await fireEvent.changeText(
      screen.getByLabelText('Companion pairing code'),
      'a'.repeat(32),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Check connection' }),
    );
    await fireEvent.press(
      screen.getByRole('checkbox', { name: 'Share earlier conversation' }),
    );
    return bridge;
  }

  const idle = (ms = idleDelayMs) =>
    act(() => jest.advanceTimersByTimeAsync(ms));

  test('summarizes on the live connection two minutes after a large turn', async () => {
    await render(<App />);
    const bridge = await connect(250_000);
    try {
      await ask('Remember my dog Rex.');
      await idle(idleDelayMs - 1);
      expect(summaries).toHaveLength(0);
      await idle(1);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].input).toEqual([
        { role: 'user', content: 'Remember my dog Rex.' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: expect.stringMatching(/^Summarize/) },
      ]);
      await act(async () => summaries[0].reply('User has a dog named Rex.'));
      expect(NativeTasks.saveCheckpoint).toHaveBeenCalledWith(
        'User has a dog named Rex.',
        '1',
      );
      // The same context is not summarized twice.
      await idle(idleDelayMs * 3);
      expect(summaries).toHaveLength(1);
    } finally {
      bridge.mockRestore();
    }
  });

  test('does not run at or below 200,000 input tokens', async () => {
    await render(<App />);
    const bridge = await connect(200_000);
    try {
      await ask('Small context.');
      await idle(idleDelayMs * 3);
      expect(summaries).toHaveLength(0);
    } finally {
      bridge.mockRestore();
    }
  });

  test('a new prompt with unknown usage cancels the summary without rearming it', async () => {
    await render(<App />);
    const bridge = await connect(250_000, undefined);
    try {
      await ask('First prompt.');
      await idle();
      expect(summaries).toHaveLength(1);
      await ask('Second prompt.');
      expect(summaries[0].signal.aborted).toBe(true);
      await act(async () => summaries[0].reply('Stale summary.'));
      expect(NativeTasks.saveCheckpoint).not.toHaveBeenCalled();
      await idle();
      expect(summaries).toHaveLength(1);
      expect(turns.map(turn => turn.status)).toEqual([
        'COMPLETED',
        'COMPLETED',
      ]);
    } finally {
      bridge.mockRestore();
    }
  });

  test.each([
    [
      'sharing is turned off',
      () =>
        fireEvent.press(
          screen.getByRole('checkbox', { name: 'Share earlier conversation' }),
        ),
    ],
    [
      'the pairing changes',
      () =>
        fireEvent.changeText(
          screen.getByLabelText('Companion pairing code'),
          'b'.repeat(32),
        ),
    ],
  ])('stops and drops the result when %s', async (_, change) => {
    await render(<App />);
    const bridge = await connect(250_000);
    try {
      await ask('First prompt.');
      await idle();
      await change();
      expect(summaries[0].signal.aborted).toBe(true);
      await act(async () => summaries[0].reply('Stale summary.'));
      expect(NativeTasks.saveCheckpoint).not.toHaveBeenCalled();
      await idle(idleDelayMs * 3);
      expect(summaries).toHaveLength(1);
    } finally {
      bridge.mockRestore();
    }
  });

  test('waits while the app is in the background', async () => {
    const listeners: ((state: string) => void)[] = [];
    const subscribe = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_, listener) => {
        listeners.push(listener as (state: string) => void);
        return { remove: jest.fn() } as never;
      });
    await render(<App />);
    const bridge = await connect(250_000);
    try {
      await ask('First prompt.');
      await idle(idleDelayMs - 1_000);
      await act(async () =>
        listeners.forEach(listener => listener('background')),
      );
      await idle(idleDelayMs * 3);
      expect(summaries).toHaveLength(0);
      await act(async () => listeners.forEach(listener => listener('active')));
      await idle();
      expect(summaries).toHaveLength(1);
    } finally {
      bridge.mockRestore();
      subscribe.mockRestore();
    }
  });
});
