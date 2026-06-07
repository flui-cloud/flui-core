export interface InferenceModel {
  id: string;
  displayName: string;
  contextWindow: number;
  supportsEmbeddings: boolean;
  supportsVision: boolean;
}

/**
 * Inference capability of a provider. OpenAI-compatible config only — no Flui
 * abstraction over the LLM. The live model list is read from `{baseUrl}/models`;
 * `models` here is an optional curated default for display before a key exists.
 */
export interface InferenceCapability {
  baseUrl: string;
  models: InferenceModel[];
  euDataResidency: boolean;
  /** True when the provider's compute credential doubles as the inference key (e.g. Scaleway IAM secret). */
  sharesComputeCredentials: boolean;
  /** Provider-specific default chat model id (model ids are not portable across providers). */
  defaultModel?: string;
}

export interface InferenceEndpoint {
  baseUrl: string;
  apiKey: string;
  /** Default chat model for this source (provider default or BYO connection's first model). */
  defaultModel?: string;
}
