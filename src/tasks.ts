import NativeTasks from './native/NativeTasks';

export type AppTarget = 'CALCULATOR' | 'MAPS';

export const appLabels = { CALCULATOR: 'Calculator', MAPS: 'Google Maps' };

type Target =
  | { type: 'app'; app: AppTarget }
  | { type: 'fromSearch'; stepId: string };

type Action =
  | { type: 'clock.startTimer'; seconds: number }
  | { type: 'apps.search'; query: string }
  | { type: 'apps.open'; target: Target }
  | { type: 'apps.observe'; target: Target };

export type TaskRequest = {
  id: string;
  steps: { id: string; action: Action; after?: string[] }[];
  failurePolicy?: 'FAIL_FAST' | 'CONTINUE_INDEPENDENT';
};

type Phase =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'SUCCEEDED'
  | 'ISSUED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'SKIPPED';

type Result =
  | { type: 'matches'; apps: AppTarget[] }
  | { type: 'window'; app: AppTarget; active: boolean; observedAt: number };

export type Task = {
  request: TaskRequest;
  states: Record<
    string,
    { phase: Phase; result: Result | null; detail: string | null }
  >;
  cancelled: boolean;
};

export const tasks = {
  async submit(request: TaskRequest): Promise<Task> {
    return JSON.parse(await NativeTasks.submit(JSON.stringify(request)));
  },
  async read(id: string | null = null): Promise<Task | null> {
    const snapshot = await NativeTasks.read(id);
    return snapshot === null ? null : JSON.parse(snapshot);
  },
  // Pages through journaled tasks newest first; pass the last task ID as `before` for the next page.
  async list(limit: number, before: string | null = null): Promise<Task[]> {
    return JSON.parse(await NativeTasks.list(before, limit));
  },
  async waitForTimer(id: string) {
    const task: Task = JSON.parse(await NativeTasks.waitForTask(id));
    return task.states.timer;
  },
  async resume(id: string): Promise<Task> {
    return JSON.parse(await NativeTasks.resume(id));
  },
  async cancel(id: string): Promise<Task> {
    return JSON.parse(await NativeTasks.cancel(id));
  },
  openAccessibilitySettings: () => NativeTasks.openAccessibilitySettings(),
};

export function mapsSteps(): TaskRequest['steps'] {
  return [
    { id: 'find', action: { type: 'apps.search', query: appLabels.MAPS } },
    {
      id: 'open',
      action: {
        type: 'apps.open',
        target: { type: 'fromSearch', stepId: 'find' },
      },
    },
  ];
}
