import type { Model } from './agent';
import NativeTasks from './native/NativeTasks';

// A ready sign-in. `account` is the stable ChatGPT account ID; `contextWindow` is null when the
// model catalog does not state one.
export type Connection = {
  account: string;
  email: string | null;
  contextWindow: number | null;
};

// The saved ChatGPT account. `signedIn` is false when ChatGPT ended the sign-in and the same
// account has to sign in again.
export type Account = {
  account: string;
  email: string | null;
  signedIn: boolean;
};

// Sign in with ChatGPT on this phone. The app keeps the credentials in native code, encrypted with
// an Android Keystore key, so JavaScript only sees account IDs and replies.
export const chatgpt = {
  async status() {
    const saved = await NativeTasks.chatgptStatus();
    return saved === null ? null : (JSON.parse(saved) as Account);
  },
  // Opens the browser and resolves once ChatGPT redirects back to the app.
  async signIn() {
    return JSON.parse(await NativeTasks.chatgptSignIn()) as Connection;
  },
  cancelSignIn: () => NativeTasks.chatgptCancelSignIn(),
  // Reuses the saved sign-in without the browser.
  async connect() {
    return JSON.parse(await NativeTasks.chatgptConnect()) as Connection;
  },
  // Resolves false when ChatGPT did not confirm the revocation.
  async signOut() {
    return (await NativeTasks.chatgptSignOut()) === 'true';
  },
  // Answers for `account` only. `onUsage` receives the input tokens of each request, or undefined
  // when unreported. An aborted `signal` discards the reply.
  model(
    account: string,
    onUsage?: (inputTokens: number | undefined) => void,
    signal?: AbortSignal,
    shareHistory = false,
  ): Model {
    return async (instructions, input) => {
      if (signal?.aborted) throw new Error('The request was cancelled.');
      const result: { text: string; inputTokens: number | null } = JSON.parse(
        await NativeTasks.chatgptRespond(
          account,
          instructions,
          JSON.stringify(input),
          shareHistory,
        ),
      );
      if (signal?.aborted) throw new Error('The request was cancelled.');
      onUsage?.(result.inputTokens ?? undefined);
      return result.text;
    };
  },
};
