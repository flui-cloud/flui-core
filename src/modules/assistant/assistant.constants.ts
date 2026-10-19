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

export const MAX_ASSISTANT_OUTPUT_TOKENS = 8192;
const DEFAULT_GUEST_OUTPUT_TOKENS = 2048;

/**
 * The `max_tokens` actually sent: the caller's number clamped to the ceiling,
 * and for a guest never more than `SANDBOX_ASSISTANT_MAX_TOKENS`, because a
 * guest's turn is paid by the instance.
 */
export function outputTokenLimit(
  spender: { guest: boolean } | undefined,
  requested: number | undefined,
): number | undefined {
  const asked =
    requested === undefined
      ? undefined
      : Math.min(requested, MAX_ASSISTANT_OUTPUT_TOKENS);
  if (!spender?.guest) return asked;
  const raw = Number(process.env.SANDBOX_ASSISTANT_MAX_TOKENS);
  const cap = Math.min(
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GUEST_OUTPUT_TOKENS,
    MAX_ASSISTANT_OUTPUT_TOKENS,
  );
  return Math.min(asked ?? cap, cap);
}
