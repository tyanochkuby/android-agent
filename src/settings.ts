import NativeTasks from './native/NativeTasks';

// The paired companion, its current connection and whether that connection may receive saved history.
// Kept on the device so a voice prompt can run while Android Agent is closed.
export type Settings = {
  pairingCode: string;
  // Present while connected; contextWindow is null when the companion did not report one.
  session?: { id: string; contextWindow: number | null };
  shareHistory: boolean;
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
  subscribe(listener: (settings: Settings) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
