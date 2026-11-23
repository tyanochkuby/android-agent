type Element = {
  path: number[];
  label: string;
  description: string | null;
  resourceId: string | null;
  className: string | null;
  editable: boolean;
  clickable: boolean;
};

export type Snapshot = { id: string; elements: Element[] };
type Selection = { snapshot: Snapshot; index: number; witness: number };

export function select(
  snapshot: Snapshot,
  predicate: (element: Element, index: number) => boolean,
  action?: 'clickable' | 'editable',
): Selection | undefined {
  const indices = new Map<number, number>();
  for (const [index, element] of snapshot.elements.entries()) {
    if (!predicate(element, index)) continue;
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
