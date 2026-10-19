import * as fs from 'node:fs';
import * as path from 'node:path';
import { DASHBOARD } from './config';
import { ModelTarget } from './models';
import { Browser, Page } from './browser';
import { parseSse } from './http';
import { Question, TurnCapture } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tees the chat's own stream inside the page: Playwright cannot read the body of
 * a streamed fetch, so the page keeps a copy, with the time of the first text.
 */
const STREAM_TAP = () => {
  const w = window as any;
  if (w.__evalTapped) return;
  w.__evalTapped = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (!String(url).includes('/assistant/v1/agent/stream'))
      return orig(input, init);
    const t0 = performance.now();
    const tap = {
      raw: '',
      ttft: null as number | null,
      firstStep: null as number | null,
      total: null as number | null,
      done: false,
    };
    w.__evalStream = tap;
    const res = await orig(input, init);
    if (!res.body) return res;
    const [a, b] = res.body.tee();
    (async () => {
      const reader = b.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        tap.raw += chunk;
        if (tap.ttft === null && chunk.includes('"type":"delta"'))
          tap.ttft = performance.now() - t0;
        if (tap.firstStep === null && chunk.includes('"type":"step"'))
          tap.firstStep = performance.now() - t0;
      }
      tap.total = performance.now() - t0;
      tap.done = true;
    })();
    return new Response(a, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
};

export async function operatorContext(
  browser: Browser,
  tab: Page,
  m: ModelTarget,
): Promise<any> {
  const session: Record<string, string> = await tab.evaluate(() => {
    const kv: Record<string, string> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      kv[k] = sessionStorage.getItem(k)!;
    }
    return kv;
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const selection = m.connectionId
    ? { connectionId: m.connectionId, model: m.model }
    : { provider: m.provider, model: m.model };
  await ctx.addInitScript(
    ({ origin, kv, sel }: any) => {
      if (window.location.origin !== origin) return;
      try {
        for (const [k, v] of Object.entries(kv))
          sessionStorage.setItem(k, v as string);
        localStorage.setItem(
          'flui.assistant.modelSelection',
          JSON.stringify(sel),
        );
      } catch {
        /* storage blocked */
      }
    },
    { origin: DASHBOARD, kv: session, sel: selection },
  );
  await ctx.addInitScript(STREAM_TAP);
  return ctx;
}

export async function guestContext(
  browser: Browser,
): Promise<{ ctx: any; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(STREAM_TAP);
  const page = await ctx.newPage();
  await page.goto(`${DASHBOARD}/try`, { waitUntil: 'load' });
  await page.waitForTimeout(9000);
  return { ctx, page };
}

export async function askUi(
  page: Page,
  q: Question,
  shotDir: string,
): Promise<{
  capture: TurnCapture;
  shots: { before: string; after: string; answer: string };
}> {
  await page.evaluate(() => {
    try {
      localStorage.removeItem('flui.assistant.history');
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${DASHBOARD}${q.page ?? '/'}`, { waitUntil: 'load' });
  await page.waitForTimeout(7000);
  fs.mkdirSync(shotDir, { recursive: true });
  const before = path.join(shotDir, `${q.id}-before.png`);
  await page.screenshot({ path: before });

  await page
    .locator('button[aria-label="Open Flui Assistant"]')
    .click({ timeout: 10000 });
  const box = page
    .locator('textarea[placeholder="Ask Flui Assistant…"]')
    .last();
  await box.waitFor({ state: 'visible', timeout: 10000 });
  await box.fill(q.question);

  let sent: TurnCapture['sent'] = {};
  const onRequest = (req: any) => {
    if (!req.url().includes('/assistant/v1/agent/stream')) return;
    try {
      const b = JSON.parse(req.postData() ?? '{}');
      sent = {
        model: b.model,
        provider: b.provider,
        connectionId: b.connectionId,
        surfaceRoute: b.surface?.surface?.route ?? b.surface?.route ?? null,
        surfaceBytes: b.surface ? JSON.stringify(b.surface).length : 0,
      };
    } catch {
      /* ignore */
    }
  };
  page.on('request', onRequest);
  await box.press('Enter');
  const deadline = Date.now() + 240000;
  let tap: any = null;
  while (Date.now() < deadline) {
    tap = await page
      .evaluate(() => (window as any).__evalStream ?? null)
      .catch(() => null);
    if (tap?.done) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2000);
  page.off('request', onRequest);
  const raw = tap?.raw ?? '';
  const status = tap ? 200 : 0;
  const ttft = tap?.ttft ?? null;
  const total = tap?.total ?? 240000;
  const after = path.join(shotDir, `${q.id}-after.png`);
  await page.screenshot({ path: after });
  const answer = path.join(shotDir, `${q.id}-answer.png`);
  // The full-screen toggle sits right before the header's close button.
  const toggleFull = () =>
    page.evaluate(() => {
      const close = document.querySelector(
        'app-assistant-widget button:has(ng-icon[name="lucideX"])',
      );
      const prev = close?.previousElementSibling as HTMLElement | null;
      if (!prev || prev.tagName !== 'BUTTON') return false;
      prev.click();
      return true;
    });
  if (await toggleFull().catch(() => false)) {
    await page.waitForTimeout(1200);
    await page
      .screenshot({ path: answer, fullPage: true })
      .catch(() => undefined);
    await toggleFull().catch(() => false);
  }
  const parsed = parseSse(raw);
  return {
    capture: {
      status,
      ttftMs: ttft,
      firstStepMs: tap?.firstStep ?? null,
      totalMs: total,
      content: parsed.content ?? '',
      type: parsed.type ?? null,
      steps: parsed.steps ?? [],
      pending: parsed.pending ?? [],
      docLinks: parsed.docLinks ?? [],
      error: parsed.error ?? null,
      transcript: parsed.transcript,
      sent,
    },
    shots: { before, after, answer },
  };
}
