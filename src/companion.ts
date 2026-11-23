import type { Model } from './agent';

type Connection = { ready: boolean; signingIn: boolean; error?: string };

export function companion(pairingCode: string) {
  async function request<T>(path: string, method: string, body?: object) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:8765${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${pairingCode}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Start the companion and connect it with adb reverse.');
    }
    if (response.status === 403)
      throw new Error('Check the companion pairing code.');
    const result = await response.json();
    if (!response.ok)
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
