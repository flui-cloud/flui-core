/**
 * Flui Assistant eval battery runner.
 *
 * Asks every question of src/modules/assistant/eval/questions.yaml through the
 * real pipeline and saves, per question and model: answer, tools called, doc
 * sections the router grounded the turn in (docLinks), tokens and cost from the
 * inference ledger, latency, screenshots, and the deterministic checks (CLI
 * commands against the oclif command tree, URLs, refusals, expected facts).
 *
 * Three paths, chosen per question:
 *  - http:        POST /assistant/v1/agent/stream from inside the author's own
 *                 dashboard tab (the token never leaves the browser), one call
 *                 per model. Used for questions without a page.
 *  - ui-operator: the real dashboard in a fresh browser context carrying the
 *                 author's session, model chosen through the picker's stored
 *                 selection, question typed in the chat widget on the page, so
 *                 the Semantic Surface sent is the one the page really builds.
 *  - ui-guest:    a /try visitor in its own context. The server pins the
 *                 guest model, so this path measures only that model.
 *
 * Needs Chrome with --remote-debugging-port (default 9222) holding a signed-in
 * localhost:4200 tab, and Playwright from the dashboard's visual bench.
 *
 *   pnpm assistant:eval -- --run baseline --models all
 *   pnpm assistant:eval -- --run t1 --models deepseek-v4-flash --ids g01,g02 --modes http
 *
 * mistral-small-4 is measured only when EVAL_MISTRAL_CONNECTION_ID is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { CDP, QUESTIONS, SHOTS_ROOT, arg, list } from './config';
import { MODELS, ModelTarget, selectModels } from './models';
import { authorTab, playwright } from './browser';
import { askHttp } from './http';
import { askUi, guestContext, operatorContext } from './ui';
import { quotaWindow } from './quota';
import { recorder } from './record';
import { Question, Result } from './types';

async function main() {
  if (process.argv.includes('--help')) {
    const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
    console.log(
      header
        .replace(/^\/\*\*\n?/, '')
        .replace(/^ \* ?/gm, '')
        .trim(),
    );
    process.exit(0);
  }
  const runName = arg(
    'run',
    new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'),
  )!;
  const models = selectModels(list(arg('models', 'deepseek-v4-flash')));
  const ids = list(arg('ids'));
  const groups = list(arg('groups'));
  const modes = list(arg('modes', 'http,ui-operator,ui-guest'))!;
  const pauseMs = Number(arg('pause', '1500'));
  // Scaleway enforces an organization-wide tokens-per-minute quota (observed
  // ~375k tokens in 60 s before "INSUFFICIENT QUOTA"); stay well under it.
  const quota = quotaWindow(Number(arg('tpm', '200000')));
  const all = yaml.load(fs.readFileSync(QUESTIONS, 'utf8')) as {
    questions: Question[];
  };
  const questions = all.questions.filter(
    (q) =>
      (!ids || ids.includes(q.id)) && (!groups || groups.includes(q.group)),
  );
  const outDir = path.join(SHOTS_ROOT, runName);
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.json');
  const results: Result[] = fs.existsSync(resultsFile)
    ? JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
    : [];
  const save = () =>
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

  const { chromium } = playwright();
  const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  const tab = await authorTab(browser);
  const record = recorder({ tab, results, save, quota, pauseMs });

  for (const m of models) {
    console.log(`== ${m.label}`);
    const httpQs = questions.filter(
      (q) => (q.as ?? 'operator') === 'operator' && !q.page,
    );
    const uiOpQs = questions.filter(
      (q) => (q.as ?? 'operator') === 'operator' && q.page,
    );
    const guestQs = questions.filter(
      (q) => q.as === 'guest' && q.via !== 'guest',
    );
    if (modes.includes('http')) {
      // Guest questions without a page are asked over HTTP too, so every model
      // answers them; the guest path below can only measure the pinned model.
      // Questions marked `via: guest` read a visitor's own data and are only
      // asked as a visitor (http-guest).
      for (const q of [...httpQs, ...guestQs.filter((g) => !g.page)]) {
        await record(q, m, 'http', async () => ({
          capture: await askHttp(tab, q, m),
        }));
      }
    }
    if (modes.includes('ui-operator') && uiOpQs.length) {
      const ctx = await operatorContext(browser, tab, m);
      const page = await ctx.newPage();
      try {
        for (const q of uiOpQs) {
          await record(q, m, 'ui-operator', () =>
            askUi(page, q, path.join(outDir, m.label)),
          );
        }
      } finally {
        await ctx.close();
      }
    }
  }

  // The server pins the guest model (SANDBOX_ASSISTANT_MODEL), so both guest
  // paths are labelled with --guest-model, which must match what the API was
  // started with; a mismatch shows as zero ledger calls for that model.
  const guestModel =
    MODELS.find((m) => m.label === arg('guest-model', 'deepseek-v4-flash')) ??
    MODELS[0];
  const guestRuns = Number(arg('guest-runs', '1'));
  if (modes.includes('http-guest')) {
    const qs = questions.filter((q) => q.as === 'guest' && !q.page);
    const perGuest = Number(arg('per-guest', '6'));
    for (let run = 1; run <= guestRuns; run++) {
      const target: ModelTarget = {
        ...guestModel,
        label: guestRuns > 1 ? `${guestModel.label}#${run}` : guestModel.label,
      };
      for (let i = 0; i < qs.length; i += perGuest) {
        const { ctx, page } = await guestContext(browser);
        try {
          for (const q of qs.slice(i, i + perGuest)) {
            await record(q, target, 'http-guest', async () => ({
              capture: await askHttp(page, q, guestModel),
            }));
          }
        } finally {
          await ctx.close();
        }
      }
    }
  }

  if (modes.includes('ui-guest')) {
    const guestQs = questions.filter(
      (q) => q.as === 'guest' && (!arg('guest-pages-only') || q.page),
    );
    if (guestQs.length) {
      // A guest area carries a token budget (SANDBOX_INFERENCE_TOKEN_BUDGET,
      // 200k by default) that a battery outspends after ~8 questions, so a new
      // visitor is opened every `perGuest` questions.
      const perGuest = Number(arg('per-guest', '6'));
      for (let run = 1; run <= guestRuns; run++) {
        const label =
          guestRuns > 1
            ? `guest-${guestModel.label}#${run}`
            : `guest-${guestModel.label}`;
        const pinned: ModelTarget = { ...guestModel, label };
        for (let i = 0; i < guestQs.length; i += perGuest) {
          const { ctx, page } = await guestContext(browser);
          try {
            for (const q of guestQs.slice(i, i + perGuest)) {
              await record(q, pinned, 'ui-guest', () =>
                askUi(page, q, path.join(outDir, label.replace('#', '-run'))),
              );
            }
          } finally {
            await ctx.close();
          }
        }
      }
    }
  }

  console.log(`results: ${resultsFile} (${results.length} rows)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
