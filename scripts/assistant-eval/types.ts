export interface Question {
  id: string;
  group: string;
  as?: 'operator' | 'guest';
  page?: string;
  question: string;
  must_include?: string[];
  must_not_include?: string[];
  expected_sections?: string[];
  expect_refusal?: boolean;
  expect_tools?: string[];
  via?: 'guest';
  note?: string;
}

export interface Step {
  name: string;
  ok: boolean;
  error?: string;
  toolCallId?: string;
}

export interface TurnCapture {
  status: number;
  ttftMs: number | null;
  firstStepMs: number | null;
  totalMs: number;
  content: string;
  type: string | null;
  steps: Step[];
  pending: { name: string; label?: string }[];
  docLinks: { title: string; url: string }[];
  error: { message: string; code?: string; retryAfter?: number } | null;
  transcript?: unknown[];
  sent?: {
    model?: string;
    provider?: string;
    connectionId?: string;
    surfaceRoute?: string | null;
    surfaceBytes?: number;
  };
}

export interface Checks {
  cli: { command: string; verdict: 'ok' | 'topic' | 'invented' }[];
  urls: {
    url: string;
    verdict:
      | 'docs-ok'
      | 'docs-invented'
      | 'sourced'
      | 'allowlisted'
      | 'unverified';
  }[];
  inventedCli: number;
  inventedUrls: number;
  looksLikeRefusal: boolean;
  refusalCorrect: boolean | null;
  mustInclude: { item: string; hit: boolean }[];
  mustNotInclude: { item: string; hit: boolean }[];
  sectionsHit: string[];
  sectionsMissed: string[];
  toolsCalled: string[];
  toolsExpectedHit: boolean | null;
  wroteWithoutApproval: boolean;
}

export interface Result {
  id: string;
  group: string;
  path: 'http' | 'http-guest' | 'ui-operator' | 'ui-guest';
  model: string;
  page?: string;
  question: string;
  capture: TurnCapture;
  tokens: {
    prompt: number;
    completion: number;
    cached: number;
    calls: number;
    estimated: number;
    clean: boolean;
  };
  costEur: number;
  /** The same turn priced as if nothing had come from the cache. */
  costEurNoCache?: number;
  checks: Checks;
  shots?: { before?: string; after?: string; answer?: string };
  quotaRetries?: number;
  silentProviderError?: boolean;
  at: string;
}
