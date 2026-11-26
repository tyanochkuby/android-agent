import NativeTasks from './native/NativeTasks';

// The current connection, the paired companion, whether the connection may receive earlier saved
// history and the history it receives without that consent. Kept on the device so a voice prompt
// can run while Android Agent is closed.
export type Settings = {
  pairingCode: string;
  session?: Session;
  shareHistory: boolean;
  scope?: HistoryScope;
};

// The turns `owner` may always receive: completed turns after `since`, or every turn when null.
// They were answered on that owner, so sending them back shares nothing new. Kept across a
// reconnect of the same owner and replaced when another owner sends a prompt.
export type HistoryScope = { owner: string; since: string | null };

// Present while connected. With `chatgpt`, `id` is the account signed in on this phone; otherwise
// it is a companion session. `contextWindow` is null when the model's window is unknown.
export type Session = {
  id: string;
  contextWindow: number | null;
  chatgpt?: true;
};

export const emptySettings: Settings = { pairingCode: '', shareHistory: false };

const listeners = new Set<(settings: Settings) => void>();

export const settings = {
  async read(): Promise<Settings> {
    const saved = await NativeTasks.readSettings();
    return saved === null ? emptySettings : JSON.parse(saved);
  },
  // Listeners see the new settings before they are written.
  async save(next: Settings) {
    listeners.forEach(listener => listener(next));
    await NativeTasks.saveSettings(JSON.stringify(next));
  },
  // Ends the connection and its consent; keeps the pairing code and the history scope.
  async disconnect() {
    const { pairingCode, scope } = await settings.read();
    await settings.save({ pairingCode, shareHistory: false, scope });
  },
  subscribe(listener: (settings: Settings) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
