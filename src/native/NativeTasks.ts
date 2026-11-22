import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  submit(request: string): Promise<string>;
  read(id: string | null): Promise<string | null>;
  resume(id: string): Promise<string>;
  cancel(id: string): Promise<string>;
  openAccessibilitySettings(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTasks');
