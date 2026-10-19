export interface ModelTarget {
  label: string;
  model: string;
  provider?: string;
  connectionId?: string;
  priceIn: number;
  priceOut: number;
  /** Price of a prompt token served from the provider's cache; priceIn when the provider has none. */
  priceCached?: number;
}

const MISTRAL_SMALL_4 = 'mistral-small-4';
const MISTRAL_CONNECTION = process.env.EVAL_MISTRAL_CONNECTION_ID;

// EUR per million tokens. Mistral Small 4 is priced in USD (0.15/0.60) and
// converted at 0.92. Cached prompt tokens come from the ledger
// (`cachedPromptTokens`) and are priced at priceCached.
export const MODELS: ModelTarget[] = [
  {
    label: 'mistral-small-3.2',
    model: 'mistral-small-3.2-24b-instruct-2506',
    provider: 'scaleway',
    priceIn: 0.15,
    priceOut: 0.35,
  },
  {
    label: 'gpt-oss-120b',
    model: 'gpt-oss-120b',
    provider: 'scaleway',
    priceIn: 0.15,
    priceOut: 0.6,
  },
  {
    label: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash-0731',
    provider: 'scaleway',
    priceIn: 0.4,
    priceOut: 0.8,
    priceCached: 0.08,
  },
  ...(MISTRAL_CONNECTION
    ? [
        {
          label: MISTRAL_SMALL_4,
          model: 'mistral-small-2603',
          connectionId: MISTRAL_CONNECTION,
          priceIn: 0.138,
          priceOut: 0.552,
        },
      ]
    : []),
];

export function selectModels(labels: string[] | undefined): ModelTarget[] {
  const all = labels?.includes('all');
  if (!MISTRAL_CONNECTION && (all || labels?.includes(MISTRAL_SMALL_4))) {
    console.log(
      `skipping ${MISTRAL_SMALL_4}: set EVAL_MISTRAL_CONNECTION_ID to include it`,
    );
  }
  return all ? MODELS : MODELS.filter((m) => labels?.includes(m.label));
}

export function turnCost(
  m: ModelTarget,
  t: { prompt: number; completion: number; cached: number },
): number {
  const cached = Math.min(Math.max(t.cached, 0), t.prompt);
  return (
    ((t.prompt - cached) * m.priceIn +
      cached * (m.priceCached ?? m.priceIn) +
      t.completion * m.priceOut) /
    1e6
  );
}
