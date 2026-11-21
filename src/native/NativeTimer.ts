import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  requestTimer(durationSeconds: number): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTimer');
