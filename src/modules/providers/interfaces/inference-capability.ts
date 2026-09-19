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
  /**
   * The model this caller gets, whatever they asked for.
   *
   * Set only where the choice is not the caller's to make — a sandbox guest,
   * whose inference the instance pays for. It rides on the endpoint rather than
   * being a second argument because every caller already threads the endpoint
   * from `resolveEndpoint` into `resolveModel`: a pin that travels with the
   * object cannot be forgotten by the seventh caller added next year.
   */
  pinnedModel?: string;
  /**
   * On whose behalf this call is made, for the ledger and for the budget.
   *
   * It rides here for the same reason the pin does: every caller already
   * threads the endpoint from `resolveEndpoint` into the call, so the meter
   * cannot be left off by a caller who did not know it existed. An endpoint
   * without a spender is the platform calling on its own behalf.
   */
  spender?: {
    userId: string | null;
    guest: boolean;
    surface: string;
  };
}
