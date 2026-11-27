import type { AgentTools, Screenshot } from './agent';
import NativeTasks from './native/NativeTasks';
import { tasks } from './tasks';

// Tasks submitted by these tools are linked to the conversation turn `turn`. A `grant` is the screen
// sharing the user allowed for a voice request; without one, UI sessions need Android Agent in front.
export const agentTools = (
  turn: string,
  grant: string | null = null,
): AgentTools => ({
  async startTimer(seconds) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await tasks.submit(
      {
        id,
        steps: [{ id: 'timer', action: { type: 'clock.startTimer', seconds } }],
      },
      turn,
    );
    return tasks.waitForTimer(id);
  },
  openApp: (app, attachOnly = false) =>
    NativeTasks.startUi(app, grant, attachOnly),
  screenStillAllowed: async () =>
    (await NativeTasks.screenAccessActive(grant)) === 'true',
  async observeUi() {
    const deadline = Date.now() + 5_000;
    let raw: string | null;
    do {
      raw = await NativeTasks.observeUi();
    } while (raw === null && Date.now() < deadline);
    return raw === null ? null : JSON.parse(raw);
  },
  async captureUi() {
    const deadline = Date.now() + 5_000;
    let raw: string | null;
    do {
      raw = await NativeTasks.captureUi();
    } while (raw === null && Date.now() < deadline);
    return raw === null ? null : JSON.parse(raw);
  },
  async listScreenshots() {
    return JSON.parse(await NativeTasks.listScreenshots(grant)) as Screenshot[];
  },
  actUi: (snapshot, index, witness, text) =>
    NativeTasks.actUi(snapshot, index, witness, text),
  closeUi: () => NativeTasks.stopUi(),
  report: ({ attempted, failed }) =>
    console.info(`Agent turn ran ${attempted} tool calls, ${failed} failed.`),
});
