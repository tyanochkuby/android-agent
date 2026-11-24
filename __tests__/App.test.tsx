import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import App from '../App';
import NativeTasks from '../src/native/NativeTasks';
import type { TaskRequest } from '../src/tasks';
import { companion } from '../src/companion';
import { instructions } from '../src/agent';

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

beforeEach(() => {
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
  jest.mocked(NativeTasks.startTurn).mockImplementation(async prompt => {
    if (turns.some(turn => turn.status === 'RUNNING')) {
      throw new Error('Finish the current prompt first.');
    }
    const id = String(turns.length + 1);
    turns.push({
      id,
      prompt,
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
  } satisfies ReturnType<typeof companion>);
  await fireEvent.changeText(
    screen.getByLabelText('Companion pairing code'),
    'a'.repeat(32),
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Check connection' }),
  );
  await fireEvent.press(
    screen.getByRole('checkbox', { name: 'Share saved conversation' }),
  );
  return bridge;
}

async function ask(prompt: string) {
  await fireEvent.changeText(screen.getByLabelText('Agent prompt'), prompt);
  await fireEvent.press(screen.getByRole('button', { name: 'Run prompt' }));
}

test('reports a selected timer as issued', async () => {
  submit.mockImplementation(async json =>
    JSON.stringify({
      request: JSON.parse(json),
      states: {
        timer: { phase: 'ISSUED', detail: 'Check Clock for the countdown.' },
      },
    }),
  );

  await render(<App />);
  await fireEvent.press(screen.getByRole('radio', { name: '5 min' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Start timer' }));

  expect(JSON.parse(submit.mock.calls[0][0]).steps).toEqual([
    { id: 'timer', action: { type: 'clock.startTimer', seconds: 300 } },
  ]);
  expect(
    screen.getByText('timer: issued · Check Clock for the countdown.'),
  ).toBeTruthy();
});

test('submits a batch binding the app selection to its search output', async () => {
  submit.mockImplementation(async json =>
    JSON.stringify({
      request: JSON.parse(json),
      states: {
        find: {
          phase: 'SUCCEEDED',
          result: { type: 'matches', apps: ['MAPS'] },
        },
        open: {
          phase: 'SUCCEEDED',
          result: { type: 'window', app: 'MAPS', active: true, observedAt: 1 },
        },
      },
    }),
  );

  await render(<App />);
  await fireEvent.press(
    screen.getByRole('button', { name: 'Find and open Google Maps' }),
  );

  expect(JSON.parse(submit.mock.calls[0][0]).steps).toEqual([
    { id: 'find', action: { type: 'apps.search', query: 'Google Maps' } },
    {
      id: 'open',
      action: {
        type: 'apps.open',
        target: { type: 'fromSearch', stepId: 'find' },
      },
    },
  ]);
  expect(
    screen.getByText('open: succeeded · Google Maps window verified'),
  ).toBeTruthy();
});

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

test('shows a submission error and allows another request', async () => {
  submit.mockRejectedValueOnce(new Error('Could not save the task.'));
  submit.mockImplementation(async json =>
    JSON.stringify({
      request: JSON.parse(json),
      states: { timer: { phase: 'ISSUED' } },
    }),
  );

  await render(<App />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start timer' }));
  expect(screen.getByText('Could not save the task.')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Start timer' }));
  expect(submit).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Could not save the task.')).toBeNull();
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
  bridge.mockReturnValue({ signIn, check, model } satisfies ReturnType<
    typeof companion
  >);
  try {
    await render(<App />);
    await fireEvent.changeText(
      screen.getByLabelText('Companion pairing code'),
      'a'.repeat(32),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
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

test.each([
  ['is rejected', false],
  ['lands without an acknowledgement', true],
])(
  'saves a reply again before the next prompt when its save %s',
  async (_, lands) => {
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

    await render(<App />);
    const bridge = await connectCompanion(model);
    try {
      await ask('First prompt');
      expect(screen.getByText(/Could not save this result/)).toBeTruthy();
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
  },
);

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
