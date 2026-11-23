import type { AgentTools } from './agent';
import NativeTasks from './native/NativeTasks';
import { tasks } from './tasks';

export const agentTools: AgentTools = {
  async startTimer(seconds) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await tasks.submit({
      id,
      steps: [{ id: 'timer', action: { type: 'clock.startTimer', seconds } }],
    });
    return tasks.waitForTimer(id);
  },
  openApp: app => NativeTasks.startUi(app),
  async observeUi() {
    const deadline = Date.now() + 5_000;
    let raw: string | null;
    do {
      raw = await NativeTasks.observeUi();
    } while (raw === null && Date.now() < deadline);
    return raw === null ? null : JSON.parse(raw);
  },
  actUi: (snapshot, index, witness, text) =>
    NativeTasks.actUi(snapshot, index, witness, text),
  closeUi: () => NativeTasks.stopUi(),
};
