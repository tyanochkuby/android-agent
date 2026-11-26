import NativeTasks from '../src/native/NativeTasks';
import * as companionModule from '../src/companion';
import { exclusive } from '../src/prompts';
import { voiceTurn } from '../src/voice';

jest.mock('../src/native/NativeTasks', () => ({
  __esModule: true,
  default: {
    readCompletedTurns: jest.fn(async () => '[]'),
    readCheckpoint: jest.fn(async () => null),
    startTurn: jest.fn(),
    completeTurn: jest.fn(),
    failTurn: jest.fn(),
    readSettings: jest.fn(),
    saveSettings: jest.fn(),
    finishVoiceTurn: jest.fn(),
    submit: jest.fn(),
  },
}));

const connected = JSON.stringify({
  pairingCode: 'a'.repeat(32),
  session: { id: 'test-session', contextWindow: null },
  shareHistory: false,
});
let model: jest.Mock;
let turn = 0;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(NativeTasks.readSettings).mockResolvedValue(connected);
  jest
    .mocked(NativeTasks.startTurn)
    .mockImplementation(async () => String(++turn));
  model = jest.fn();
  jest.spyOn(companionModule, 'companion').mockReturnValue({
    signIn: jest.fn(),
    check: jest.fn(),
    model,
    liveModel: jest.fn(),
  });
});

test('runs the transcript as a saved turn and returns the reply', async () => {
  model.mockResolvedValue('[{"tool":"finish","message":"It is sunny."}]');

  await voiceTurn({ id: 'voice-1', transcript: ' What is the weather? ' });

  expect(NativeTasks.startTurn).toHaveBeenCalledWith(
    'What is the weather?',
    expect.any(String),
  );
  expect(NativeTasks.completeTurn).toHaveBeenCalledWith(
    String(turn),
    'It is sunny.',
  );
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-1',
    'It is sunny.',
    false,
  );
});

test('refuses Android actions and never submits a task', async () => {
  model
    .mockResolvedValueOnce('[{"tool":"start_timer","seconds":60}]')
    .mockResolvedValueOnce('[{"tool":"finish","message":"Open the app."}]');

  await voiceTurn({ id: 'voice-2', transcript: 'Start a timer' });

  expect(NativeTasks.submit).not.toHaveBeenCalled();
  expect(JSON.stringify(model.mock.calls[1][1])).toContain(
    'Voice prompts are text-only.',
  );
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-2',
    'Open the app.',
    false,
  );
});

test('records a failed turn while signed out', async () => {
  jest
    .mocked(NativeTasks.readSettings)
    .mockResolvedValue(
      JSON.stringify({ pairingCode: '', shareHistory: false }),
    );

  await voiceTurn({ id: 'voice-3', transcript: 'Hello' });

  expect(model).not.toHaveBeenCalled();
  expect(NativeTasks.failTurn).toHaveBeenCalledWith(
    String(turn),
    'Connect the companion in Android Agent.',
  );
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-3',
    'Connect the companion in Android Agent.',
    true,
  );
});

test('ignores a repeated delivery of the same transcript', async () => {
  model.mockResolvedValue('[{"tool":"finish","message":"Hi."}]');

  await voiceTurn({ id: 'voice-4', transcript: 'Hello' });
  await voiceTurn({ id: 'voice-4', transcript: 'Hello' });

  expect(NativeTasks.startTurn).toHaveBeenCalledTimes(1);
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledTimes(1);
});

test('reports busy without starting a turn while another prompt runs', async () => {
  let release!: () => void;
  const typed = exclusive(
    () => new Promise<void>(resolve => (release = resolve)),
  );

  await voiceTurn({ id: 'voice-5', transcript: 'Hello' });
  release();
  await typed;

  expect(NativeTasks.startTurn).not.toHaveBeenCalled();
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-5',
    expect.stringContaining('finishing another prompt'),
    true,
  );
});
