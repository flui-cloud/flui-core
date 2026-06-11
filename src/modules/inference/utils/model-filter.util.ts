/**
 * The Flui assistant only uses text/tool-use chat models. Provider `/models` listings
 * also surface embeddings, audio (voice/TTS/transcription), OCR, moderation, image,
 * realtime and legacy completion models that can't back a chat turn — drop them from
 * the picker (OpenAI 404s "not a chat model" if one is picked).
 *
 * Matched as delimiter-bounded tokens (ids are `-`/`_`/`/`/`.`-separated), so a category
 * keyword only triggers on a whole segment. Some embedding families (bge/gte/e5) carry no
 * "embed" keyword, so their family prefix is matched explicitly.
 */
const AUDIO_MODEL =
  /(?:^|[-_/.])(?:whisper|voxtral|tts|stt|asr|audio|speech|voice|transcribe|transcription)(?:[-_/.]|$)/i;

const NON_TEXT_MODEL =
  /(?:^|[-_/.])(?:embed(?:ding)?s?|bge|gte|e5|rerank(?:er)?|moderation|guard|safety|ocr)(?:[-_/.]|$)/i;

// OpenAI's catalog mixes non-chat models in with chat ones: image generation, realtime
// audio, code/computer-use, and legacy GPT-3 completion/base models. None back chat
// completions. `instruct` is NOT here — it means chat on Scaleway/Mistral; OpenAI's only
// completion-mode `instruct` is `gpt-3.5-turbo-instruct`, handled explicitly below.
const NON_CHAT_OPENAI =
  /(?:^|[-_/.])(?:davinci|babbage|curie|realtime|image|dall|codex|computer)(?:[-_/.]|$)/i;

export function isAssistantModel(modelId: string): boolean {
  if (modelId.includes('turbo-instruct')) return false;
  return (
    !AUDIO_MODEL.test(modelId) &&
    !NON_TEXT_MODEL.test(modelId) &&
    !NON_CHAT_OPENAI.test(modelId)
  );
}

export function filterAssistantModels(modelIds: string[]): string[] {
  return modelIds.filter(isAssistantModel);
}
