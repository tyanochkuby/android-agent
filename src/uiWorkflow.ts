import NativeTasks from './native/NativeTasks';

type Element = {
  path: number[];
  label: string;
  description: string | null;
  resourceId: string | null;
  className: string | null;
  editable: boolean;
  clickable: boolean;
};

type Snapshot = { id: string; elements: Element[] };
type Selection = { snapshot: Snapshot; index: number; witness: number };

export function select(
  snapshot: Snapshot,
  predicate: (element: Element) => boolean,
  action?: 'clickable' | 'editable',
): Selection | undefined {
  const indices = new Map<number, number>();
  for (const [index, element] of snapshot.elements.entries()) {
    if (!predicate(element)) continue;
    let target = index;
    if (action && !element[action]) {
      const path = element.path;
      target = snapshot.elements.reduce(
        (closest, candidate, candidateIndex) =>
          candidate[action] &&
          candidate.path.length < path.length &&
          candidate.path.every((part, offset) => part === path[offset]) &&
          (closest === -1 ||
            candidate.path.length > snapshot.elements[closest].path.length)
            ? candidateIndex
            : closest,
        -1,
      );
    }
    if (target >= 0) indices.set(target, index);
  }
  if (indices.size > 1) throw new Error('More than one element matched.');
  const selected = indices.entries().next().value;
  return selected && { snapshot, index: selected[0], witness: selected[1] };
}

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
  await NativeTasks.startUi(app);
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
