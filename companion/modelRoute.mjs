// Sends model requests over a provider's live connection when there is one, else through `fallback`.
// `live` is optional and provider-specific:
//   canReuse()                  whether an open connection can take a request now
//   respond(request, signal)    resolves { text, inputTokens, cachedTokens }, opening a connection
//                               if needed
//   close()                     drops the connection
// `fallback(request, signal)` resolves { text } and reports no usage.
//
// A `liveOnly` request runs only on a connection that is already open and idle. It never opens one
// and never falls back, so a background request cannot turn a cold cache into new work. Any other
// request takes priority and cancels a running `liveOnly` request first.
export function modelRoute({ live, fallback }) {
  let background;

  async function respondLive(request, signal) {
    if (!live?.canReuse() || background) {
      throw new Error('No live model connection.');
    }
    const controller = new AbortController();
    const run = live.respond(
      request,
      AbortSignal.any([signal, controller.signal]),
    );
    background = { controller, run };
    try {
      return await run;
    } finally {
      if (background?.run === run) background = undefined;
    }
  }

  return {
    async respond(request, { signal, liveOnly = false }) {
      if (liveOnly) return respondLive(request, signal);
      if (background) {
        background.controller.abort();
        await background.run.catch(() => {});
      }
      if (live) {
        try {
          return await live.respond(request, signal);
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      const { text } = await fallback(request, signal);
      return { text };
    },
    close() {
      background?.controller.abort();
      live?.close();
    },
  };
}
