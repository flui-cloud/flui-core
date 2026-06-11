/** Low temperature keeps answers grounded and the guardrails adherent. */
export const DEFAULT_ASSISTANT_TEMPERATURE = 0.2;

// Substrings flagging non-chat models (embeddings, audio, rerank) used to skip them when
// falling back to the endpoint's live model list. Provider/connection defaults are preferred.
const NON_CHAT_HINTS = ['embed', 'bge', 'rerank', 'whisper', 'voxtral', 'tts'];

/** Pick a chat-capable model id from an endpoint's list, skipping embedding/audio models. */
export function pickChatModel(models: string[]): string | undefined {
  const chat = models.find(
    (id) => !NON_CHAT_HINTS.some((h) => id.toLowerCase().includes(h)),
  );
  return chat ?? models[0];
}
