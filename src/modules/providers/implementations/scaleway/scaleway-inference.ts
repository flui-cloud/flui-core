import { InferenceCapability } from '../../interfaces/inference-capability';

// Scaleway Generative APIs — OpenAI-compatible. The IAM secret key is the bearer token,
// so the compute credential doubles as the inference key. Live models come from /models.
export const SCALEWAY_INFERENCE: InferenceCapability = {
  baseUrl: 'https://api.scaleway.ai/v1',
  models: [],
  euDataResidency: true,
  sharesComputeCredentials: true,
  defaultModel: 'mistral-small-3.2-24b-instruct-2506',
};
