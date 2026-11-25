// A live connection for `modelRoute` over one reused OpenAI Responses WebSocket. Every request
// sends its full input with `store: false`. Reusing the socket is what let the provider reuse a
// cached prefix in the warm-cache probes; a replacement socket started cold.
// `open(signal)` resolves an open, authenticated WHATWG WebSocket. The provider SDK owns its
// credentials; tests pass a fake.
export function openaiSocket({ open }) {
  let socket;
  let busy = false;

  async function connected(signal) {
    if (socket?.readyState === 1) return socket;
    const ws = await open(signal);
    socket = ws;
    ws.addEventListener('close', () => {
      if (socket === ws) socket = undefined;
    });
    return ws;
  }

  function exchange(ws, body, signal) {
    return new Promise((resolve, reject) => {
      let text = '';
      const settle = (error, result) => {
        ws.removeEventListener('message', message);
        ws.removeEventListener('close', closed);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(result);
      };
      const message = ({ data }) => {
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        switch (event?.type) {
          case 'response.output_text.delta':
            if (typeof event.delta === 'string') text += event.delta;
            break;
          case 'response.completed': {
            const usage = event.response?.usage;
            const tokens = usage?.input_tokens;
            const cached = usage?.input_tokens_details?.cached_tokens;
            settle(undefined, {
              text,
              ...(Number.isSafeInteger(tokens) && { inputTokens: tokens }),
              ...(Number.isSafeInteger(cached) && { cachedTokens: cached }),
            });
            break;
          }
          case 'error':
          case 'response.failed':
          case 'response.incomplete': {
            // Provider error bodies can quote the request; report only the code.
            const code =
              event.error?.code ?? event.response?.error?.code ?? event.type;
            settle(new Error(`The model request failed (${code}).`));
            break;
          }
        }
      };
      const closed = () =>
        settle(new Error('The model connection closed during the request.'));
      // A socket cannot drop one response, so cancelling closes it; the next request reconnects.
      const aborted = () => {
        settle(new Error('The model request was cancelled.'));
        ws.close();
      };
      ws.addEventListener('message', message);
      ws.addEventListener('close', closed);
      signal.addEventListener('abort', aborted);
      if (signal.aborted) return aborted();
      ws.send(JSON.stringify(body));
    });
  }

  return {
    canReuse: () => !busy && socket?.readyState === 1,
    async respond({ model, instructions, input }, signal) {
      if (busy) throw new Error('The model connection is busy.');
      busy = true;
      try {
        const ws = await connected(signal);
        return await exchange(
          ws,
          {
            type: 'response.create',
            model,
            instructions,
            input: input.map(({ role, content }) => ({ role, content })),
            store: false,
          },
          signal,
        );
      } finally {
        busy = false;
      }
    },
    close() {
      socket?.close();
      socket = undefined;
    },
  };
}
