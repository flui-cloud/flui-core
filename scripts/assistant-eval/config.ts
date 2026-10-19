import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const QUESTIONS = path.join(
  ROOT,
  'src/modules/assistant/eval/questions.yaml',
);
export const CLI_COMMANDS = path.join(ROOT, 'cli/src/commands');
export const DOCS_DIR =
  process.env.FLUI_DOCS_DIR ??
  path.resolve(ROOT, '../flui-docs/src/content/docs');
export const BENCH =
  process.env.VISUAL_BENCH_DIR ??
  path.resolve(ROOT, '../flui-dashboard/tools/visual-bench');
export const SHOTS_ROOT =
  process.env.ASSISTANT_EVAL_OUT ?? path.resolve(ROOT, '../SCATTI_ASSISTENTE');
export const API = process.env.FLUI_API_URL ?? 'http://localhost:3000/api/v1';
export const DASHBOARD =
  process.env.FLUI_DASHBOARD_URL ?? 'http://localhost:4200';
export const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222';

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

export function list(v: string | undefined): string[] | undefined {
  return v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}
