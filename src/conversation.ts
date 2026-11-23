import type { Message } from './agent';
import NativeTasks from './native/NativeTasks';

export type ConversationTurn = {
  id: string;
  prompt: string;
  reply: string | null;
};

export const conversation = {
  async read(): Promise<ConversationTurn[]> {
    return JSON.parse(await NativeTasks.readConversation());
  },
  start: (prompt: string) => NativeTasks.startTurn(prompt),
  saveReply: (id: string, reply: string) => NativeTasks.saveReply(id, reply),
};

export function conversationContext(turns: ConversationTurn[]): Message[] {
  return turns
    .flatMap<Message>(({ prompt, reply }) =>
      reply === null
        ? []
        : [
            { role: 'user', content: prompt },
            { role: 'assistant', content: reply },
          ],
    )
    .slice(-12);
}
