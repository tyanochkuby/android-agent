import type { AgentTools } from './agent';
import NativeTasks from './native/NativeTasks';
import { ask, exclusive } from './prompts';

async function refuse(): Promise<never> {
  throw new Error(
    'Voice prompts are text-only. Open Android Agent to run Android actions.',
  );
}

// Voice prompts run while another app is in front, so they take no Android actions.
const textOnly: AgentTools = {
  startTimer: refuse,
  openApp: refuse,
  observeUi: refuse,
  actUi: refuse,
  closeUi: async () => {},
};

const received = new Set<string>();

// Headless task for one final transcript. Runs it as a text-only prompt through the same path as
// typed prompts and hands the reply or failure back to Android. A repeated `id` is ignored, so a
// duplicate delivery never starts a second turn. Nothing is queued: a busy runtime reports busy.
export async function voiceTurn({
  id,
  transcript,
}: {
  id: string;
  transcript: string;
}) {
  if (received.has(id)) return;
  received.add(id);
  let text: string;
  let failed = true;
  try {
    const run = exclusive(() => ask(transcript.trim(), false, () => textOnly));
    if (run) {
      const { outcome } = await run;
      failed = 'failure' in outcome;
      text = 'reply' in outcome ? outcome.reply : outcome.failure;
    } else {
      text = 'Android Agent is finishing another prompt. Try again when it is done.';
    }
  } catch (error) {
    text =
      (error instanceof Error && error.message) || 'Could not save the prompt.';
  }
  await NativeTasks.finishVoiceTurn(id, text, failed);
}
