import { idleCompactor, idleDelayMs } from '../src/idleCompaction';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const pending = () => {
  const runs: { signal: AbortSignal; settle: () => void }[] = [];
  const compact = jest.fn(
    (signal: AbortSignal) =>
      new Promise<void>(resolve => runs.push({ signal, settle: resolve })),
  );
  return { compact, runs };
};

test('runs once, two minutes after it starts, only above 200,000 input tokens', async () => {
  const compactor = idleCompactor();
  const { compact, runs } = pending();

  compactor.report(200_000);
  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).not.toHaveBeenCalled();

  compactor.report(200_001);
  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs - 1);
  expect(compact).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(compact).toHaveBeenCalledTimes(1);

  runs[0].settle();
  await jest.advanceTimersByTimeAsync(0);
  // The run consumed the report, so idling again does not repeat it.
  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).toHaveBeenCalledTimes(1);
});

test('a failed run is not retried for the same context', async () => {
  const compactor = idleCompactor();
  const compact = jest.fn().mockRejectedValue(new Error('No live connection'));
  compactor.report(250_000);
  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  await jest.runAllTicks();
  await Promise.resolve();

  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).toHaveBeenCalledTimes(1);
});

test('activity restarts the idle period and stop aborts a running compaction', async () => {
  const compactor = idleCompactor();
  const { compact, runs } = pending();
  compactor.report(250_000);
  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs - 1_000);
  compactor.stop();
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).not.toHaveBeenCalled();

  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).toHaveBeenCalledTimes(1);
  compactor.stop();
  expect(runs[0].signal.aborted).toBe(true);

  // Resume while the cancelled request is still settling.
  compactor.start(compact);
  runs[0].settle();
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).toHaveBeenCalledTimes(2);
});

test('a newer report during an aborted run is kept', async () => {
  const compactor = idleCompactor();
  const { compact, runs } = pending();
  compactor.report(250_000);
  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  compactor.stop();
  compactor.report(100);
  runs[0].settle();
  await Promise.resolve();
  await Promise.resolve();

  compactor.start(compact);
  jest.advanceTimersByTime(idleDelayMs);
  expect(compact).toHaveBeenCalledTimes(1);
});
