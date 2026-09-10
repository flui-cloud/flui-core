import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { resolveConnectedRepository } from '../../../lib/resolve-repository';
import type { RepositoryMapResponseDto } from '../../../../../src/modules/repositories/dto/repository-map.dto';

/** Nothing is deployed by this call, but a large repository takes a while to read. */
const READ_TIMEOUT_MS = 0;

const MARK: Record<string, string> = {
  deployable: chalk.green('●'),
  deployable_pending_inputs: chalk.yellow('●'),
  blocked: chalk.red('●'),
  insufficient_capacity: chalk.red('●'),
  not_assessed: chalk.dim('○'),
};

export default class RepoMapShow extends Command {
  static readonly description =
    'Read a connected repository and print what it says about itself: deployable units, the services it wants, the variables it needs, blockers, caveats, open questions, a verdict, and the flui.yaml Flui would render — every fact with its file:line and how firm it is. ' +
    'Read-only: nothing is deployed, provisioned, written or committed. It is one way to get a manifest, not the only one — `flui deploy` takes a flui.yaml you wrote yourself, and an image you already have needs neither.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> acme/shop',
    '<%= config.bin %> <%= command.id %> acme/shop --branch develop',
    '<%= config.bin %> <%= command.id %> acme/shop --unit api',
    '<%= config.bin %> <%= command.id %> acme/shop --output json',
  ];

  static readonly args = {
    repository: Args.string({
      description:
        'Connected repository: `owner/repo`, a GitHub URL, or its id',
      required: true,
    }),
  };

  static readonly flags = {
    branch: Flags.string({
      char: 'b',
      description:
        'Git ref to read (defaults to the repository default branch)',
    }),
    cluster: Flags.string({
      char: 'c',
      description:
        'Weigh the map against this cluster (name or id). Half the verdict is capacity, so one is always chosen.',
    }),
    unit: Flags.string({
      char: 'u',
      description: 'Show only this unit (its id, `.` for the repository root)',
    }),
    output: Flags.string({
      char: 'o',
      description:
        'Output format. `json` prints the whole response, untouched.',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoMapShow);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let repo;
    let cluster;
    try {
      repo = await resolveConnectedRepository(api, args.repository);
      cluster = await resolveClusterRef(flags.cluster);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }

    const branch = flags.branch ?? repo.defaultBranch;
    const spinner =
      flags.output === 'json'
        ? undefined
        : ora(
            `Reading ${chalk.bold(repo.repositoryFullName)}@${branch}…`,
          ).start();

    let map: RepositoryMapResponseDto;
    try {
      const query = new URLSearchParams({ clusterId: cluster.id });
      if (flags.branch) query.set('branch', flags.branch);
      map = await api.post<RepositoryMapResponseDto>(
        `/repositories/${encodeURIComponent(repo.id)}/map?${query.toString()}`,
        undefined,
        { timeoutMs: READ_TIMEOUT_MS },
      );
      spinner?.succeed(`Read ${repo.repositoryFullName}@${branch}`);
    } catch (error: unknown) {
      spinner?.fail('Could not read the repository');
      const detail =
        (error as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? (error as Error).message;
      this.error(detail, { exit: 1 });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(map, null, 2));
      return;
    }

    this.render(map, cluster.name, flags.unit);
  }

  private render(
    map: RepositoryMapResponseDto,
    clusterName: string,
    unitId?: string,
  ): void {
    const only = <T extends { unit?: string | null }>(rows: T[]): T[] =>
      unitId ? rows.filter((r) => r.unit === unitId || r.unit === null) : rows;

    const branchLabel = chalk.dim(`@${map.branch}`);
    const clusterLabel = chalk.dim(`cluster ${clusterName}`);
    console.log('');
    console.log(
      `  ${chalk.bold(map.repoFullName)}  ${branchLabel}  ${clusterLabel}`,
    );
    if (map.read.commitSha) {
      const commitLabel = chalk.dim(
        `commit ${map.read.commitSha.slice(0, 12)}`,
      );
      console.log(`  ${commitLabel}`);
    }
    this.renderRead(map);
    this.renderVerdict(map, unitId);
    this.renderUnits(map, unitId);
    this.renderList(
      'Services wanted',
      only(map.map?.services ?? []).map((s) => {
        const blockLabel = s.block ? chalk.dim(` → ${s.block}`) : '';
        const meta = chalk.dim(`${s.confidence} · ${s.source}`);
        return `${s.name}${blockLabel}  ${meta}`;
      }),
    );
    this.renderInputs(only(map.map?.inputs ?? []));
    this.renderList(
      'Blockers',
      only(map.map?.blockers ?? []).map((b) => {
        const remedyLabel = chalk.dim(`remedy: ${b.remedy}`);
        return `${chalk.red(b.code)} ${b.summary}\n      ${chalk.dim(b.source)}\n      ${remedyLabel}`;
      }),
    );
    this.renderList(
      'Caveats',
      only(map.map?.caveats ?? []).map(
        (c) => `${chalk.yellow(c.code)} ${c.summary}  ${chalk.dim(c.source)}`,
      ),
    );
    this.renderList(
      'Open questions',
      (map.map?.questions ?? []).map((q) => {
        const optionsLabel = q.options.length
          ? chalk.dim(`  [${q.options.join(' | ')}]`)
          : '';
        return `${q.question}${optionsLabel}\n      ${chalk.dim(q.source)}`;
      }),
    );
    this.renderRender(map, unitId);
  }

  /** Where the engine stopped looking. A fact missing from a truncated read was never looked for. */
  private renderRead(map: RepositoryMapResponseDto): void {
    if (!map.read.ok) {
      console.log(
        `\n  ${chalk.red('Could not be read:')} ${map.read.reason ?? 'unknown'}`,
      );
      return;
    }
    if (map.read.truncated || map.read.contentComplete === false) {
      console.log(
        `\n  ${chalk.yellow('Partial read')} — the repository was not read to the end, so anything absent below may simply not have been looked at.`,
      );
      const unread = map.read.highDensityUnread ?? [];
      if (unread.length) {
        console.log(chalk.dim(`      left unread: ${unread.join(', ')}`));
      }
    }
  }

  private renderVerdict(map: RepositoryMapResponseDto, unitId?: string): void {
    const verdict = map.verdict;
    console.log('');
    console.log(
      `  ${MARK[verdict.outcome] ?? '●'} ${chalk.bold(verdict.outcome)}  ${verdict.reason}`,
    );
    if (verdict.remedy) console.log(chalk.dim(`      ${verdict.remedy}`));
    const capacity = verdict.capacity;
    if (capacity?.assessed === false) {
      console.log(
        chalk.dim(
          `      capacity not assessed: ${capacity.notAssessedReason ?? 'no reason given'}`,
        ),
      );
    }
    if (capacity?.uncounted?.length) {
      console.log(
        chalk.dim(
          `      will run but was not weighed: ${capacity.uncounted.join(', ')}`,
        ),
      );
    }
    for (const unit of verdict.units ?? []) {
      if (unitId && unit.id !== unitId) continue;
      const statusLabel = chalk.dim(`${unit.readiness} — ${unit.reason}`);
      console.log(
        `    ${MARK[unit.readiness] ?? '●'} ${unit.id.padEnd(14)} ${statusLabel}`,
      );
      if (unit.remedy) console.log(chalk.dim(`        ${unit.remedy}`));
    }
  }

  private renderUnits(map: RepositoryMapResponseDto, unitId?: string): void {
    const units = (map.map?.units ?? []).filter(
      (u) => !unitId || u.id === unitId,
    );
    if (units.length === 0) return;
    console.log(`\n  ${chalk.bold('Units')}`);
    for (const unit of units) {
      const port = unit.port ? `port ${unit.port.value}` : 'no port read';
      const secrets = unit.env.filter((e) => e.role === 'secret').length;
      const summary = chalk.dim(
        `${unit.build.strategy} · ${port} · ${unit.env.length} env (${secrets} secret) · ${unit.confidence}`,
      );
      console.log(`    ${unit.id.padEnd(14)} ${summary}`);
    }
  }

  private renderInputs(
    inputs: Array<{
      name: string;
      secret: boolean;
      blocksStart?: true;
      source: string;
    }>,
  ): void {
    if (inputs.length === 0) return;
    const countLabel = chalk.dim(`(${inputs.length})`);
    console.log(`\n  ${chalk.bold('Inputs required')}  ${countLabel}`);
    for (const input of inputs) {
      const tags = [
        input.secret ? chalk.magenta('secret') : null,
        input.blocksStart ? chalk.red('blocks start') : null,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `    ${input.name.padEnd(28)} ${tags}  ${chalk.dim(input.source)}`,
      );
    }
    console.log(
      chalk.dim(
        '    Secrets are delivered by a person after the apply — `flui app env set <app> KEY=…`.',
      ),
    );
  }

  private renderList(title: string, rows: string[]): void {
    if (rows.length === 0) return;
    const countLabel = chalk.dim(`(${rows.length})`);
    console.log(`\n  ${chalk.bold(title)}  ${countLabel}`);
    for (const row of rows) console.log(`    ${row}`);
  }

  private renderRender(map: RepositoryMapResponseDto, unitId?: string): void {
    const render = map.render;
    if (!render) return;
    const units = render.units.filter((u) => !unitId || u.unitId === unitId);
    if (units.length) {
      console.log(`\n  ${chalk.bold('Would render')}`);
      for (const unit of units) {
        const path =
          unit.unitId === '.' ? 'flui.yaml' : `${unit.unitId}/flui.yaml`;
        console.log(`    ${path.padEnd(28)} ${chalk.dim(unit.name)}`);
      }
    }
    for (const skipped of render.skipped) {
      console.log(
        chalk.dim(`    ${skipped.unitId}: not rendered — ${skipped.reason}`),
      );
    }
    for (const note of render.notes) {
      console.log(chalk.dim(`    ${note.unitId}: ${note.message}`));
    }
    console.log('');
    console.log(
      chalk.dim(
        `  See a manifest:  flui repo map show ${map.repoFullName} --output json\n` +
          `  Act on it:       flui repo map apply ${map.repoFullName}\n`,
      ),
    );
  }
}
