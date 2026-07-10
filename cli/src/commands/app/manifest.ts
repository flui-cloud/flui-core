import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { applicationSchema } from '@flui-cloud/spec';

/**
 * Per-framework container port + healthcheck path used to seed `--example`.
 * Mirrors the server-side template registry; kept inline so the command works
 * fully offline (no API, no auth).
 */
const FRAMEWORK_DEFAULTS: Record<
  string,
  { port: number; healthcheck: string }
> = {
  nextjs: { port: 3000, healthcheck: '/api/health' },
  nuxt: { port: 3000, healthcheck: '/api/health' },
  sveltekit: { port: 3000, healthcheck: '/api/health' },
  nestjs: { port: 3000, healthcheck: '/health' },
  angular: { port: 80, healthcheck: '/health' },
  astro: { port: 80, healthcheck: '/health' },
  'vue-vite': { port: 80, healthcheck: '/health' },
  vitepress: { port: 80, healthcheck: '/health' },
  'spring-boot': { port: 8080, healthcheck: '/actuator/health' },
  'aspnet-core': { port: 8080, healthcheck: '/health' },
  django: { port: 8000, healthcheck: '/health/' },
  fastapi: { port: 8000, healthcheck: '/health' },
  generic: { port: 3000, healthcheck: '/health' },
};

const DEFAULT_FRAMEWORK = { port: 3000, healthcheck: '/health' };

type JsonSchema = Record<string, any>;

export default class AppManifest extends Command {
  static readonly description =
    'Print the flui.yaml (kind: Application) authoring reference — for humans and ' +
    'for LLMs generating a manifest. Runs fully offline (no cluster, no auth).\n\n' +
    'The manifest contract is the published `@flui-cloud/spec` schema, so this ' +
    'output can never drift from what `flui deploy` validates.';

  static readonly summary =
    'Print the flui.yaml (kind: Application) schema & annotated example — for humans and LLMs.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --example',
    '<%= config.bin %> <%= command.id %> --example nextjs',
  ];

  static readonly enableJsonFlag = true;

  static readonly args = {
    framework: Args.string({
      description:
        'Framework for --example (e.g. nextjs, spring-boot, fastapi). Sets port + healthcheck.',
      required: false,
    }),
  };

  static readonly flags = {
    example: Flags.boolean({
      description:
        'Emit a fully-annotated example manifest instead of the field reference.',
      default: false,
    }),
  };

  async run(): Promise<JsonSchema | void> {
    const { args, flags } = await this.parse(AppManifest);

    if (this.jsonEnabled()) {
      return applicationSchema as JsonSchema;
    }

    if (flags.example) {
      this.log(buildExample(args.framework));
      return;
    }

    this.log(buildReference(applicationSchema as JsonSchema));
  }
}

function buildExample(framework?: string): string {
  const key = framework?.toLowerCase();
  const fw = (key && FRAMEWORK_DEFAULTS[key]) || DEFAULT_FRAMEWORK;
  const label = key && FRAMEWORK_DEFAULTS[key] ? ` (${key})` : '';
  return [
    `# flui.yaml — kind: Application${label}`,
    '# Deploys a source-code repo (built from its Dockerfile) to a Flui cluster.',
    'apiVersion: flui.cloud/v1beta1',
    'kind: Application',
    'metadata:',
    '  name: my-app                    # lowercase slug — your app identifier',
    'build:',
    '  strategy: dockerfile            # build the repo Dockerfile (or `auto` for railpack)',
    '  dockerfile: ./Dockerfile        # monorepo: point at the subdir, e.g. api/Dockerfile',
    '  context: .                      # monorepo: e.g. api',
    'deploy:',
    `  port: ${fw.port}                       # MUST match the port your code binds (process.env.PORT)`,
    '  exposure: public                # public = public HTTPS URL (auto TLS+DNS) · internal = dashboard-only',
    '  healthcheck:',
    `    path: ${fw.healthcheck}${' '.repeat(Math.max(1, 22 - fw.healthcheck.length))}# MUST be a real route that returns 2xx`,
    '  resources:',
    '    requests: { cpu: 250m, memory: 256Mi }',
    '    limits: { cpu: "1", memory: 512Mi }',
    '  env:',
    '    # RUNTIME env only. Build-time vars (NEXT_PUBLIC_*, VITE_*, PUBLIC_*) are baked',
    '    # at image build — declare those as ARG/ENV in your Dockerfile, not here.',
    '    - name: NODE_ENV',
    '      value: production',
    '  # domain:',
    '  #   fqdn: app.example.com        # optional explicit hostname (apex or other zone)',
    '',
    '  # --- planned: accepted by the spec but NOT yet applied on source deploys ---',
    '  # resources.profile · deploy.scaling · env[].valueFrom · env[].secret',
    '  # `flui deploy --validate-only` will warn if you use them.',
  ].join('\n');
}

/** Render a compact, human-readable field reference derived from the JSON Schema. */
function buildReference(schema: JsonSchema): string {
  const header =
    chalk.bold('\nflui.yaml — kind: Application (v1beta1)\n') +
    '\n' +
    chalk.dim(
      'Deploy a source-code repository to a Flui cluster. Fields marked ',
    ) +
    chalk.yellow('[planned]') +
    chalk.dim(' are accepted but not yet applied on source deploys.');
  const footer = [
    chalk.dim('Full JSON Schema:   flui app manifest --json'),
    chalk.dim('Annotated example:  flui app manifest --example [framework]'),
  ].join('\n');

  const fields: string[] = [];
  renderObject(schema, schema, fields, 0);

  return [header, '', fields.join('\n'), '', footer, ''].join('\n');
}

function resolveRef(root: JsonSchema, node: JsonSchema): JsonSchema {
  if (typeof node?.$ref !== 'string') return node;
  const path = node.$ref.replace(/^#\//, '').split('/');
  let cur: any = root;
  for (const seg of path) cur = cur?.[seg];
  return cur ?? node;
}

function renderObject(
  root: JsonSchema,
  node: JsonSchema,
  lines: string[],
  depth: number,
): void {
  if (depth > 3) return;
  const props = node.properties as Record<string, JsonSchema> | undefined;
  if (!props) return;
  const required = new Set<string>(node.required ?? []);
  const indent = '  '.repeat(depth + 1);

  for (const [name, rawChild] of Object.entries(props)) {
    const child = resolveRef(root, rawChild);
    renderField(name, rawChild, child, required.has(name), indent, lines);
    renderChildren(root, child, lines, depth);
  }
}

function renderField(
  name: string,
  rawChild: JsonSchema,
  child: JsonSchema,
  isRequired: boolean,
  indent: string,
  lines: string[],
): void {
  const req = isRequired ? chalk.red('required') : chalk.dim('optional');
  const planned =
    isPlanned(rawChild) || isPlanned(child)
      ? ' ' + chalk.yellow('[planned]')
      : '';
  const meta = describeType(child);
  const head = `${indent}${chalk.cyan(name)}  ${req}${meta ? '  ' + chalk.dim(meta) : ''}${planned}`;
  const rows =
    typeof child.description === 'string'
      ? [head, `${indent}  ${chalk.dim(child.description)}`]
      : [head];
  lines.push(...rows);
}

function renderChildren(
  root: JsonSchema,
  child: JsonSchema,
  lines: string[],
  depth: number,
): void {
  if (child.type === 'object' && child.properties) {
    renderObject(root, child, lines, depth + 1);
  } else if (child.type === 'array' && child.items) {
    const items = resolveRef(root, child.items as JsonSchema);
    if (items.properties) renderObject(root, items, lines, depth + 1);
  }
}

function isPlanned(node: JsonSchema): boolean {
  return node?.['x-flui-status'] === 'planned';
}

function describeType(node: JsonSchema): string {
  if (Array.isArray(node.enum)) return node.enum.join(' | ');
  if (typeof node.const === 'string') return `"${node.const}"`;
  if (node.type === 'array') return 'array';
  if (node.type) return String(node.type);
  return '';
}
