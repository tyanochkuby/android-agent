import NativeTasks from '../src/native/NativeTasks';
import * as companionModule from '../src/companion';
import { exclusive } from '../src/prompts';
import { voiceTurn } from '../src/voice';

jest.mock('../src/native/NativeTasks', () => ({
  __esModule: true,
  default: {
    readConversation: jest.fn(async () => '[]'),
    readCompletedTurns: jest.fn(async () => '[]'),
    readCheckpoint: jest.fn(async () => null),
    startTurn: jest.fn(),
    completeTurn: jest.fn(),
    failTurn: jest.fn(),
    readSettings: jest.fn(),
    saveSettings: jest.fn(),
    finishVoiceTurn: jest.fn(),
    chatgptStatus: jest.fn(async () => null),
    chatgptSignIn: jest.fn(),
    chatgptCancelSignIn: jest.fn(),
    chatgptConnect: jest.fn(),
    chatgptSignOut: jest.fn(),
    chatgptRespond: jest.fn(),
    submit: jest.fn(),
    startUi: jest.fn(),
    screenAccessActive: jest.fn(async () => 'true'),
    observeUi: jest.fn(),
    stopUi: jest.fn(),
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
    expect.stringMatching(/^companion:/),
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
    'Sign in with ChatGPT in Android Agent.',
  );
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-3',
    'Sign in with ChatGPT in Android Agent.',
    true,
  );
});

test('answers on the ChatGPT account signed in on the phone', async () => {
  jest.mocked(NativeTasks.readSettings).mockResolvedValue(
    JSON.stringify({
      pairingCode: '',
      session: { id: 'user-1', contextWindow: null, chatgpt: true },
      shareHistory: false,
    }),
  );
  jest.mocked(NativeTasks.chatgptRespond).mockResolvedValue(
    JSON.stringify({
      text: '[{"tool":"finish","message":"Hi there."}]',
      inputTokens: null,
    }),
  );

  await voiceTurn({ id: 'voice-6', transcript: 'Hello' });

  expect(model).not.toHaveBeenCalled();
  expect(NativeTasks.chatgptRespond).toHaveBeenCalledWith(
    'user-1',
    expect.any(String),
    expect.stringContaining('"content":"Hello"'),
    false,
  );
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-6',
    'Hi there.',
    false,
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

test('reads the app the user asked from under the screen grant', async () => {
  jest.mocked(NativeTasks.observeUi).mockResolvedValue(
    JSON.stringify({
      id: 'video',
      elements: [
        {
          path: [0],
          label: 'FAV TRACKS: TOGETHER',
          description: null,
          resourceId: null,
          className: null,
          clickable: false,
          editable: false,
        },
      ],
    }),
  );
  model
    .mockResolvedValueOnce('[{"tool":"observe_ui"}]')
    .mockResolvedValueOnce('[{"tool":"start_timer","seconds":60}]')
    .mockResolvedValueOnce('[{"tool":"finish","message":"Together."}]');

  await voiceTurn({
    id: 'voice-7',
    transcript: 'What is the first favourite track?',
    screen: { grant: 'grant-1', source: 'com.example.video' },
  });

  expect(NativeTasks.startUi).toHaveBeenCalledWith(
    'com.example.video',
    'grant-1',
    true,
  );
  expect(JSON.stringify(model.mock.calls[1][1])).toContain('FAV TRACKS');
  expect(NativeTasks.submit).not.toHaveBeenCalled();
  expect(NativeTasks.stopUi).toHaveBeenCalledTimes(1);
  expect(NativeTasks.finishVoiceTurn).toHaveBeenCalledWith(
    'voice-7',
    'Together.',
    false,
  );
});
