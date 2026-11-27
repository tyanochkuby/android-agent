import type { Model } from './agent';

type Connection = {
  ready: boolean;
  signingIn: boolean;
  sessionId?: string;
  // Context window of the selected model in tokens; null when the catalog does not state one.
  contextWindow?: number | null;
  error?: string;
};

// `onUsage` receives the input token count for each request, or undefined when unavailable.
export function companion(
  pairingCode: string,
  sessionId?: string,
  onUsage?: (inputTokens: number | undefined) => void,
) {
  async function request<T>(
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) {
    // React Native fetch uses JS timers to deliver replies. Direct XHR
    // callbacks continue while the target app owns the foreground.
    const response = await new Promise<XMLHttpRequest>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('The request was cancelled.'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open(method, `http://127.0.0.1:8765${path}`);
      xhr.timeout = 60_000;
      xhr.setRequestHeader('Authorization', `Bearer ${pairingCode}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => resolve(xhr);
      xhr.onerror = () =>
        reject(
          new Error('Start the companion and connect it with adb reverse.'),
        );
      xhr.ontimeout = () => reject(new Error('The companion did not reply.'));
      xhr.onabort = () => reject(new Error('The request was cancelled.'));
      signal?.addEventListener('abort', () => xhr.abort());
      xhr.send(body === undefined ? null : JSON.stringify(body));
    });
    if (response.status === 403)
      throw new Error('Check the companion pairing code.');
    const result = JSON.parse(response.responseText);
    if (response.status < 200 || response.status >= 300)
      throw new Error(result.error ?? 'The companion request failed.');
    return result as T;
  }

  function infer(liveOnly: boolean, signal?: AbortSignal): Model {
    return async (instructions, input) => {
      const result = await request<{ text: string; inputTokens?: number }>(
        '/infer',
        'POST',
        // The companion sends text only.
        {
          sessionId,
          instructions,
          input: input.map(({ role, content }) => ({ role, content })),
          liveOnly,
        },
        signal,
      );
      onUsage?.(result.inputTokens);
      return result.text;
    };
  }
  return {
    check: () => request<Connection>('/status', 'GET'),
    signIn: () => request<Connection>('/sign-in', 'POST'),
    model: infer(false),
    // Runs only on the companion's already open model connection, so it never starts cold work.
    // Aborting `signal` cancels the request.
    liveModel: (signal: AbortSignal) => infer(true, signal),
  };
}
