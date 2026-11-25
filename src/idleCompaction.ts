// Idle compaction runs only once the latest request was reported above this many input tokens.
export const idleCompactionTokens = 200_000;
// Live-connection cache hits held through 30 minutes in the warm-cache probes, but the provider
// closed idle connections after 171 and 400 seconds, so compaction runs early.
export const idleDelayMs = 120_000;

// Schedules at most one background compaction per reported context.
// `report` records the input tokens of each prompt request. `start` arms the timer while the app is
// open and idle, and runs `compact` after `idleDelayMs` if the latest report passed
// `idleCompactionTokens`. `stop` clears the timer and aborts a running compaction; call it when a
// prompt starts, the session or sharing changes, or the app leaves the foreground.
// A run that finishes or fails consumes the report. An aborted run keeps it for the next `start`.
export function idleCompactor() {
  let inputTokens: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | undefined;

  function stop() {
    clearTimeout(timer);
    timer = undefined;
    running?.abort();
    running = undefined;
  }

  return {
    report(tokens: number) {
      inputTokens = tokens;
    },
    start(compact: (signal: AbortSignal) => Promise<unknown>) {
      stop();
      const tokens = inputTokens;
      if (tokens === undefined || tokens <= idleCompactionTokens) return;
      timer = setTimeout(() => {
        timer = undefined;
        inputTokens = undefined;
        const controller = new AbortController();
        running = controller;
        compact(controller.signal)
          .catch(() => {})
          .finally(() => {
            if (running === controller) running = undefined;
            if (controller.signal.aborted) inputTokens ??= tokens;
          });
      }, idleDelayMs);
    },
    stop,
  };
}
