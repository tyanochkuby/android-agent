import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  submit(request: string): Promise<string>;
  read(id: string | null): Promise<string | null>;
  readConversation(): Promise<string>;
  startTurn(prompt: string): Promise<string>;
  saveReply(id: string, reply: string): Promise<void>;
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
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTasks');
