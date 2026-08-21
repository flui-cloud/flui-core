/**
 * The inference half of the example world — the part of Settings that says
 * which models the platform talks to.
 *
 * A stand-in rather than a read: the real answer names the operator's own
 * provider credential and the endpoints it reaches. What matters to show is
 * that the capability is there and how it is arranged — a provider whose
 * compute credential doubles as its inference key, and a second endpoint
 * brought by whoever runs the instance.
 *
 * No key, no token, not even an invented one. The section says the credential
 * exists; the value is never in the response — a fake key is still a string
 * shaped like a key, and in a screenshot it cannot be told from a leak.
 */
import { daysAgo, mark, ORG_NAME } from './sandbox-world-core';

export function exampleInferenceProviders() {
  return [
    mark({
      provider: 'scaleway',
      baseUrl: 'https://api.scaleway.ai/v1',
      euDataResidency: true,
      configured: true,
      models: [
        'mistral-small-3.2-24b-instruct-2506',
        'llama-3.3-70b-instruct',
        'qwen2.5-coder-32b-instruct',
      ],
      defaultModel: 'mistral-small-3.2-24b-instruct-2506',
    }),
  ];
}

export function exampleInferenceConnections(now: number) {
  return [
    mark({
      id: 'example-inference-connection-1',
      label: `${ORG_NAME} self-hosted models`,
      baseUrl: 'https://models.internal.example.net/v1',
      models: ['qwen2.5-14b-instruct'],
      isDefault: false,
      createdAt: daysAgo(now, 12),
    }),
  ];
}

/**
 * The credentials banner, which every screen asks about.
 *
 * The real answer describes the operator's own GitHub App, registry token and
 * provider credentials — their state, not the guest's. And there is nothing of
 * the guest's to describe: a tenancy holds no credential of its own. So the
 * answer is an empty list, which is the truth ("nothing here needs your
 * attention") and invents no connection the guest does not have.
 */
export function exampleCredentialsStatus() {
  return mark({ overallStatus: 'VALID', items: [] });
}
