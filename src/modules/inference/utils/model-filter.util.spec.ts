import { filterAssistantModels, isAssistantModel } from './model-filter.util';

describe('model-filter.util', () => {
  // Real Scaleway + Mistral + OpenAI chat/tool-use models that must stay in the picker.
  const KEEP = [
    'mistral-small-3.2-24b-instruct-2506',
    'mistral-small-2506',
    'mistral-medium-2508',
    'devstral-2-123b-instruct-2512',
    'qwen3-235b-a22b-instruct-2507',
    'llama-3.3-70b-instruct',
    'pixtral-12b-2409',
    'codestral-2508',
    'ministral-3-8b-2512',
    'magistral-medium-1209',
    'gpt-oss-120b',
    'deepseek-r1-distill-llama-70b',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4-turbo',
    'chatgpt-4o-latest',
    'o1',
    'o3-mini',
    'o4-mini',
    'gpt-4o-search-preview',
  ];

  // Real non-chat models (embeddings, audio/voice/TTS, OCR, moderation, image,
  // realtime, legacy completion/base) that must be dropped.
  const DROP = [
    'whisper-large-v3',
    'voxtral-small-24b-2507',
    'voxtral-mini-transcribe-2602',
    'voxtral-mini-transcribe-realtime-2602',
    'voxtral-tts-2603',
    'bge-multilingual-gemma2',
    'qwen3-embedding-8b',
    'mistral-embed-2312',
    'mistral-embed',
    'codestral-embed-2505',
    'mistral-ocr-2512',
    'mistral-moderation-2603',
    'mistral-moderation-latest',
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-instruct-0914',
    'davinci-002',
    'babbage-002',
    'gpt-image-1',
    'dall-e-3',
    'gpt-4o-realtime-preview',
    'gpt-4o-audio-preview',
    'gpt-4o-transcribe',
    'codex-mini-latest',
    'text-embedding-3-large',
    'tts-1',
    'omni-moderation-latest',
  ];

  it.each(KEEP)('keeps assistant-usable model %s', (id) => {
    expect(isAssistantModel(id)).toBe(true);
  });

  it.each(DROP)('drops non-chat model %s', (id) => {
    expect(isAssistantModel(id)).toBe(false);
  });

  it('filters a mixed list preserving order', () => {
    expect(filterAssistantModels([...KEEP, ...DROP])).toEqual(KEEP);
  });
});
