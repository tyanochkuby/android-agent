import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import App from '../App';
import NativeTimer from '../src/native/NativeTimer';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('../src/native/NativeTimer', () => ({
  __esModule: true,
  default: { requestTimer: jest.fn() },
}));

const requestTimer = jest.mocked(NativeTimer.requestTimer);

beforeEach(() => requestTimer.mockReset());

test('sends the selected duration to Android and reports the handoff', async () => {
  requestTimer.mockResolvedValue(undefined);

  await render(<App />);
  await fireEvent.press(screen.getByRole('radio', { name: '5 min' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Start timer' }));

  expect(requestTimer).toHaveBeenCalledTimes(1);
  expect(requestTimer).toHaveBeenCalledWith(300);
  expect(
    screen.getByText('Sent a 5-minute timer request to Clock.'),
  ).toBeTruthy();
});

test('shows the native failure and allows another request', async () => {
  requestTimer.mockRejectedValueOnce(new Error('Clock is unavailable.'));
  requestTimer.mockResolvedValueOnce(undefined);

  await render(<App />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start timer' }));
  expect(screen.getByText('Clock is unavailable.')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Start timer' }));
  expect(requestTimer).toHaveBeenNthCalledWith(2, 600);
  expect(screen.queryByText('Clock is unavailable.')).toBeNull();
});
