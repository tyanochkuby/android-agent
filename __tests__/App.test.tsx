import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import App from '../App';
import NativeTasks from '../src/native/NativeTasks';
import type { TaskRequest } from '../src/tasks';
import { companion } from '../src/companion';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('../src/native/NativeTasks', () => ({
  __esModule: true,
  default: {
    submit: jest.fn(),
    read: jest.fn(),
    readConversation: jest.fn(),
    startTurn: jest.fn(),
    saveReply: jest.fn(),
    resume: jest.fn(),
    cancel: jest.fn(),
    openAccessibilitySettings: jest.fn(),
  },
}));

const submit = jest.mocked(NativeTasks.submit);
const read = jest.mocked(NativeTasks.read);
const resume = jest.mocked(NativeTasks.resume);
const readConversation = jest.mocked(NativeTasks.readConversation);
const startTurn = jest.mocked(NativeTasks.startTurn);
const saveReply = jest.mocked(NativeTasks.saveReply);

beforeEach(() => {
  submit.mockReset();
  read.mockReset();
  resume.mockReset();
  read.mockResolvedValue(null);
  readConversation.mockReset().mockResolvedValue('[]');
  startTurn.mockReset();
  saveReply.mockReset();
});

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

test('restores a saved exchange and uses it for a follow-up with fresh consent', async () => {
  const bridge = jest.spyOn(require('../src/companion'), 'companion');
  const signIn = jest.fn().mockResolvedValue({ signingIn: true });
  const check = jest.fn().mockResolvedValue({ ready: true });
  const model = jest
    .fn()
    .mockResolvedValueOnce(
      '[{"tool":"finish","message":"Ready for Android tasks."}]',
    )
    .mockResolvedValueOnce(
      '[{"tool":"finish","message":"I can set a timer."}]',
    );
  const code = 'a'.repeat(32);
  const turns: { id: string; prompt: string; reply: string | null }[] = [];
  readConversation.mockImplementation(async () => JSON.stringify(turns));
  startTurn.mockImplementation(async prompt => {
    const id = String(turns.length + 1);
    turns.push({ id, prompt, reply: null });
    return id;
  });
  saveReply.mockImplementation(async (id, reply) => {
    turns.find(turn => turn.id === id)!.reply = reply;
  });
  bridge.mockReturnValue({ signIn, check, model } satisfies ReturnType<
    typeof companion
  >);
  try {
    const first = await render(<App />);
    await fireEvent.changeText(
      screen.getByLabelText('Companion pairing code'),
      code,
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
      `What can you do? ${code}`,
    );
    expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(
      false,
    );
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByRole('button', { name: 'Run prompt' }));
    expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(
      false,
    );
    expect(screen.getByText('Ready for Android tasks.')).toBeTruthy();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledWith(
      'What can you do? [pairing code removed]',
    );
    expect(saveReply).toHaveBeenCalledWith('1', 'Ready for Android tasks.');

    await first.unmount();
    await render(<App />);
    expect(screen.getByText('Ready for Android tasks.')).toBeTruthy();
    expect(screen.getByLabelText('Companion pairing code').props.value).toBe(
      '',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Companion pairing code'),
      code,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Check connection' }),
    );
    await fireEvent.changeText(
      screen.getByLabelText('Agent prompt'),
      'Give me an example.',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Run prompt' }));
    expect(model).toHaveBeenLastCalledWith(
      expect.stringContaining('Screen sharing is off'),
      [
        { role: 'user', content: 'What can you do? [pairing code removed]' },
        { role: 'assistant', content: 'Ready for Android tasks.' },
        { role: 'user', content: 'Give me an example.' },
      ],
    );
  } finally {
    bridge.mockRestore();
  }
});
