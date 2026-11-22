import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import App from '../App';
import NativeTasks from '../src/native/NativeTasks';
import type { TaskRequest } from '../src/tasks';

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
  },
}));

const submit = jest.mocked(NativeTasks.submit);
const read = jest.mocked(NativeTasks.read);
const resume = jest.mocked(NativeTasks.resume);

beforeEach(() => {
  submit.mockReset();
  read.mockReset();
  resume.mockReset();
  read.mockResolvedValue(null);
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
  const subscribe = jest.spyOn(AppState, 'addEventListener');
  let finishRead: (value: null) => void = () => {};
  read.mockReturnValueOnce(
    new Promise(resolve => {
      finishRead = resolve;
    }),
  );

  const view = await render(<App />);
  const onAppStateChanged = subscribe.mock.lastCall![1];
  try {
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
  } finally {
    await view.unmount();
    subscribe.mockRestore();
  }
});
