import NativeTasks from './native/NativeTasks';
import type { Snapshot } from './uiSelection';
import { select } from './uiSelection';

export { select };

type Selection = NonNullable<ReturnType<typeof select>>;

export async function runUiWorkflow<T>(
  app: string,
  work: (ui: {
    waitFor: (
      predicate: (snapshot: Snapshot) => Selection | undefined,
    ) => Promise<Selection>;
    click: (selection: Selection) => Promise<string>;
    setText: (selection: Selection, text: string) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  await NativeTasks.startUi(app, null, false);
  try {
    return await work({
      async waitFor(predicate) {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const raw = await NativeTasks.observeUi();
          const match = raw && predicate(JSON.parse(raw));
          if (match) return match;
        }
        throw new Error('The expected screen did not appear.');
      },
      click({ snapshot, index, witness }) {
        return NativeTasks.actUi(snapshot.id, index, witness, null);
      },
      setText({ snapshot, index, witness }, text) {
        return NativeTasks.actUi(snapshot.id, index, witness, text);
      },
    });
  } finally {
    await NativeTasks.stopUi();
  }
}

export async function actOn(
  find: () => Promise<Selection>,
  act: (selection: Selection) => Promise<string>,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await act(await find());
    if (outcome === 'issued') return;
    if (outcome !== 'stale') throw new Error('Unexpected UI action outcome.');
  }
  throw new Error('The screen kept changing before the action could run.');
}
