import * as path from 'node:path';
import { createRequire } from 'node:module';
import { API, BENCH, DASHBOARD } from './config';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Page = any;
export type Browser = any;

export function playwright(): any {
  const req = createRequire(path.join(BENCH, 'package.json'));
  return req('@playwright/test');
}

export async function authorTab(browser: Browser): Promise<Page> {
  let best: Page = null;
  let bestExp = -1;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith(DASHBOARD)) continue;
      const exp = await p
        .evaluate(() => Number(sessionStorage.getItem('expires_at')) || 0)
        .catch(() => 0);
      if (exp > bestExp) {
        bestExp = exp;
        best = p;
      }
    }
  }
  if (!best || bestExp < Date.now() + 5 * 60_000) {
    throw new Error(
      'No dashboard tab with an access token valid for at least 5 more minutes.',
    );
  }
  return best;
}

async function apiGet(tab: Page, p: string): Promise<any> {
  return tab.evaluate(
    async ([api, pth]: string[]) => {
      const t = sessionStorage.getItem('access_token');
      const r = await fetch(api + pth, {
        headers: { Authorization: `Bearer ${t}` },
      });
      return r.ok ? r.json() : { __status: r.status };
    },
    [API, p],
  );
}

export interface UsageSnap {
  byModel: Record<
    string,
    {
      calls: number;
      promptTokens: number;
      completionTokens: number;
      cachedPromptTokens?: number;
      estimated: number;
    }
  >;
  byPerson: Record<string, number>;
}

export async function usage(tab: Page): Promise<UsageSnap> {
  const u = await apiGet(tab, '/inference/usage?days=2');
  const byModel: UsageSnap['byModel'] = {};
  for (const m of u.byModel ?? []) byModel[m.model] = m;
  const byPerson: UsageSnap['byPerson'] = {};
  for (const p of u.byPerson ?? [])
    byPerson[String(p.userId)] = Number(p.tokens);
  return { byModel, byPerson };
}

export function usageDelta(before: UsageSnap, after: UsageSnap, model: string) {
  const a = after.byModel[model] ?? {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimated: 0,
  };
  const b = before.byModel[model] ?? {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimated: 0,
  };
  const prompt = Number(a.promptTokens) - Number(b.promptTokens);
  const completion = Number(a.completionTokens) - Number(b.completionTokens);
  const cached =
    Number(a.cachedPromptTokens ?? 0) - Number(b.cachedPromptTokens ?? 0);
  // Clean when exactly one person's spend moved, and by the same amount.
  const moved = Object.keys(after.byPerson).filter(
    (k) => (after.byPerson[k] ?? 0) !== (before.byPerson[k] ?? 0),
  );
  const personDelta = moved.reduce(
    (s, k) => s + (after.byPerson[k] - (before.byPerson[k] ?? 0)),
    0,
  );
  return {
    prompt,
    completion,
    cached,
    calls: Number(a.calls) - Number(b.calls),
    estimated: Number(a.estimated) - Number(b.estimated),
    clean: moved.length <= 1 && personDelta === prompt + completion,
  };
}
