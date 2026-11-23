import type { Model } from './agent';

type Connection = { ready: boolean; signingIn: boolean; error?: string };

export function companion(pairingCode: string) {
  async function request<T>(path: string, method: string, body?: object) {
    // React Native fetch uses JS timers to deliver replies. Direct XHR
    // callbacks continue while the target app owns the foreground.
    const response = await new Promise<XMLHttpRequest>((resolve, reject) => {
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
      xhr.send(body === undefined ? null : JSON.stringify(body));
    });
    if (response.status === 403)
      throw new Error('Check the companion pairing code.');
    const result = JSON.parse(response.responseText);
    if (response.status < 200 || response.status >= 300)
      throw new Error(result.error ?? 'The companion request failed.');
    return result as T;
  }

  const model: Model = async (instructions, input) => {
    const result = await request<{ text: string }>('/infer', 'POST', {
      instructions,
      input,
    });
    return result.text;
  };
  return {
    check: () => request<Connection>('/status', 'GET'),
    signIn: () => request<Connection>('/sign-in', 'POST'),
    model,
  };
}
