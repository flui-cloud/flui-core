import { Page, usage, usageDelta } from './browser';
import { runChecks } from './checks';
import { ModelTarget, turnCost } from './models';
import { QuotaWindow } from './quota';
import { Question, Result, TurnCapture } from './types';

export type Run = () => Promise<{
  capture: TurnCapture;
  shots?: Result['shots'];
}>;
export type RecordTurn = (
  q: Question,
  m: ModelTarget,
  pathKind: Result['path'],
  run: Run,
) => Promise<void>;

export function recorder(opts: {
  tab: Page;
  results: Result[];
  save: () => void;
  quota: QuotaWindow;
  pauseMs: number;
}): RecordTurn {
  const { tab, results, save, quota, pauseMs } = opts;
  const done = new Set(results.map((r) => `${r.id}|${r.model}|${r.path}`));
  return async (q, m, pathKind, run) => {
    const key = `${q.id}|${m.label}|${pathKind}`;
    if (done.has(key)) return;
    let attempt = 0;
    let quotaRetries = 0;
    for (;;) {
      await quota.pace();
      const before = await usage(tab);
      const { capture, shots } = await run();
      await new Promise((r) => setTimeout(r, 800));
      const after = await usage(tab);
      const tokens = usageDelta(before, after, m.model);
      quota.add(tokens.prompt + tokens.completion);
      // An empty turn whose ledger calls are all estimated, with no completion,
      // is a provider error that reached the agent as a silent empty answer.
      const silentProviderError =
        !capture.content &&
        !capture.steps.length &&
        !capture.pending.length &&
        tokens.estimated > 0 &&
        tokens.completion === 0;
      if (silentProviderError && quotaRetries < 4) {
        quotaRetries++;
        console.log(
          `  ${key} empty answer with estimated usage (provider error), retry ${quotaRetries} in 65s`,
        );
        await new Promise((r) => setTimeout(r, 65_000));
        continue;
      }
      if (capture.error?.code === 'rate_limit' && attempt < 3) {
        attempt++;
        const wait = Math.max(10, capture.error.retryAfter ?? 20) * 1000;
        console.log(`  ${key} rate limited, retry in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const costEur = turnCost(m, tokens);
      const costEurNoCache = turnCost(m, { ...tokens, cached: 0 });
      const checks = runChecks(q, capture);
      checks.wroteWithoutApproval = false;
      results.push({
        id: q.id,
        group: q.group,
        path: pathKind,
        model: m.label,
        page: q.page,
        question: q.question,
        capture,
        tokens,
        costEur,
        costEurNoCache,
        checks,
        shots,
        quotaRetries,
        silentProviderError,
        at: new Date().toISOString(),
      });
      save();
      console.log(
        `  ${key} ${capture.error ? 'ERR ' + capture.error.message.slice(0, 60) : 'ok'} ` +
          `ttft=${capture.ttftMs?.toFixed?.(0) ?? capture.ttftMs} total=${capture.totalMs.toFixed(0)} ` +
          `tok=${tokens.prompt}/${tokens.completion} cached=${tokens.cached} €${costEur.toFixed(4)} tools=[${checks.toolsCalled.join(',')}] ` +
          `cliInv=${checks.inventedCli} urlInv=${checks.inventedUrls}`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  };
}
