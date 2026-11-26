import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  submit(request: string, turn: string | null): Promise<string>;
  read(id: string | null): Promise<string | null>;
  list(before: string | null, limit: number): Promise<string>;
  readConversation(before: string | null, limit: number): Promise<string>;
  readCompletedTurns(after: string | null, limit: number): Promise<string>;
  readCheckpoint(): Promise<string | null>;
  saveCheckpoint(summary: string, covers: string): Promise<void>;
  startTurn(prompt: string, attempt: string): Promise<string>;
  completeTurn(id: string, reply: string): Promise<void>;
  failTurn(id: string, detail: string): Promise<void>;
  waitForTask(id: string): Promise<string>;
  resume(id: string): Promise<string>;
  cancel(id: string): Promise<string>;
  startUi(app: string): Promise<void>;
  observeUi(): Promise<string | null>;
  actUi(
    snapshot: string,
    element: number,
    witness: number,
    text: string | null,
  ): Promise<string>;
  stopUi(): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  readSettings(): Promise<string | null>;
  saveSettings(settings: string): Promise<void>;
  finishVoiceTurn(id: string, text: string, failed: boolean): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTasks');
