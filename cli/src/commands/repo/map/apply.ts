import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { confirmPrompt } from '../../../lib/prompts';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { resolveConnectedRepository } from '../../../lib/resolve-repository';
import type { RepositoryApplyResponseDto } from '../../../../../src/modules/repositories/dto/repository-apply.dto';

/**
 * No client deadline. The apply provisions every service the rendered
 * manifests declare — a Postgres, a Redis — and waits for them to be RUNNING
 * before it answers, which is minutes. With the client's default 30s the CLI
 * printed a failure while the server carried on committing, so the only
 * visible outcome was one that had not happened. Same reason `flui deploy`
 * passes 0.
 */
const APPLY_TIMEOUT_MS = 0;

export default class RepoMapApply extends Command {
  static readonly description =
    'Act on the map of a connected repository. Flui cuts its OWN branch `flui/deploy-<sha7>` at the commit it read, lands one commit on it with a rendered flui.yaml and a build workflow per unit, and creates one application per unit on that branch. Your branch is read and never written to. ' +
    'This writes to the real GitHub repository and spends its Actions minutes. Run `flui repo map show` first — an apply is refused when the verdict is blocked, insufficient_capacity or not_assessed.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> acme/shop',
    '<%= config.bin %> <%= command.id %> acme/shop --unit api --unit web',
    '<%= config.bin %> <%= command.id %> acme/shop --branch develop --yes',
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
        'The branch to read and cut from (defaults to the repository default branch). Never written to.',
    }),
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster the applications are created on (name or id)',
    }),
    unit: Flags.string({
      char: 'u',
      description:
        'Apply only this unit; repeat for several. Omitted, every rendered unit is applied.',
      multiple: true,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Do not ask for confirmation',
      default: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoMapApply);

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
    const units = flags.unit as string[] | undefined;

    if (!flags.yes && flags.output !== 'json') {
      console.log('');
      console.log(
        `  Flui will cut a branch in ${chalk.bold(repo.repositoryFullName)}, commit a flui.yaml and a build`,
      );
      console.log(
        `  workflow per unit, and start a GitHub Actions build for each.`,
      );
      const contextLabel = chalk.dim(
        `Read from ${branch} (never written to) · applications on cluster ${cluster.name}`,
      );
      console.log(`  ${contextLabel}`);
      if (units?.length) {
        console.log(chalk.dim(`  Only these units: ${units.join(', ')}`));
      }
      console.log('');
      if (!(await confirmPrompt('  Apply?', false))) {
        console.log(chalk.dim('\n  Cancelled. Nothing was written.\n'));
        return;
      }
    }

    const spinner =
      flags.output === 'json'
        ? undefined
        : ora('Applying — this installs the declared services first…').start();

    let applied: RepositoryApplyResponseDto;
    try {
      applied = await api.post<RepositoryApplyResponseDto>(
        `/repositories/${encodeURIComponent(repo.id)}/map/apply`,
        {
          clusterId: cluster.id,
          ...(flags.branch ? { branch: flags.branch } : {}),
          ...(units?.length ? { unitIds: units } : {}),
        },
        { timeoutMs: APPLY_TIMEOUT_MS },
      );
      spinner?.succeed(`Committed on ${applied.branch}`);
    } catch (error: unknown) {
      spinner?.fail('Apply failed');
      const detail =
        (error as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? (error as Error).message;
      console.log(chalk.red(`\n  ${detail}\n`));
      if (/verdict is/i.test(detail)) {
        console.log(
          chalk.yellow(
            `  Read what the map objected to:  flui repo map show ${repo.repositoryFullName}\n`,
          ),
        );
      }
      this.exit(1);
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(applied, null, 2));
      return;
    }

    this.render(applied);
  }

  private render(applied: RepositoryApplyResponseDto): void {
    console.log('');
    console.log(`  ${chalk.bold('Branch:')} ${applied.branch}`);
    console.log(`  ${chalk.dim(applied.branchUrl)}`);
    const baseLabel = chalk.dim(
      `cut from ${applied.baseBranch}@${applied.baseCommitSha.slice(0, 7)}`,
    );
    console.log(
      `  ${chalk.bold('Commit:')} ${applied.commitSha.slice(0, 12)}  ${baseLabel}`,
    );
    console.log(
      `  ${chalk.bold('Files:')}  ${applied.files.length}  ${chalk.dim(applied.files.join(', '))}`,
    );

    console.log('');
    for (const unit of applied.units) {
      const mark = unit.armed ? chalk.green('●') : chalk.yellow('●');
      console.log(
        `  ${mark} ${chalk.bold(unit.slug)}  ${chalk.dim(unit.status)}`,
      );
      console.log(
        chalk.dim(`      ${unit.manifestPath} · ${unit.workflowPath}`),
      );
      if (unit.workflowRunUrl) {
        console.log(chalk.dim(`      build: ${unit.workflowRunUrl}`));
      }
      if (unit.pendingInputs?.length) {
        console.log(
          `      ${chalk.magenta('needs:')} ${unit.pendingInputs.join(', ')}  ` +
            chalk.dim(`flui app env set ${unit.slug} <KEY>=…`),
        );
      }
      if (!unit.armed) {
        console.log(chalk.yellow(`      ${unit.reason ?? 'not armed'}`));
      }
    }

    for (const skipped of applied.skipped) {
      console.log(
        chalk.dim(
          `  ○ ${skipped.unitId}  not rendered, nothing created — ${skipped.reason}`,
        ),
      );
    }

    if (applied.partial) {
      console.log('');
      console.log(
        chalk.yellow(
          '  Partial: the commit is real and every build is running, but at least one unit was not armed —\n' +
            '  its build reports to a webhook that answers 401, so it will not deploy on its own. Do not re-run\n' +
            '  the apply from this commit; act on the reason above.',
        ),
      );
    }

    console.log('');
    console.log(
      chalk.dim(
        `  Follow a build:  flui app status ${applied.units[0]?.slug ?? '<app>'}\n`,
      ),
    );
  }
}
