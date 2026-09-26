import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  AppRuntime,
  CliAppService,
  ResourceProposalAnswer,
  ResourcesConsequence,
} from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppResources extends Command {
  static readonly description =
    'Show or change how much CPU and memory an application may use. Without a change flag it shows the current values. A container is stopped for crossing its memory limit, never its request — the request is what a machine keeps free for it. Changing either restarts the application.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --memory-limit 1Gi',
    '<%= config.bin %> <%= command.id %> my-api --cpu-request 250m --memory-request 256Mi',
    '<%= config.bin %> <%= command.id %> my-api --memory-request 2Gi --dry-run',
    '<%= config.bin %> <%= command.id %> my-db --apply-proposal',
    '<%= config.bin %> <%= command.id %> my-db --apply-proposal --at-next-window',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    'cpu-request': Flags.string({
      description: 'CPU a machine keeps free for it, e.g. 250m or 0.5',
    }),
    'cpu-limit': Flags.string({
      description: 'Most CPU it may use, e.g. 500m or 1',
    }),
    'memory-request': Flags.string({
      description: 'Memory a machine keeps free for it, e.g. 256Mi',
    }),
    'memory-limit': Flags.string({
      description:
        'Most memory it may use before it is stopped, e.g. 512Mi or 1Gi',
    }),
    'dry-run': Flags.boolean({
      description:
        'Write nothing: show the values as they would be stored and where the replicas would run — on a node already there, on a machine the scaling group would buy or propose, or nowhere yet',
      default: false,
    }),
    'apply-proposal': Flags.boolean({
      description:
        'Apply the memory change Flui proposes (shown with the current values), as it stands now. The application restarts.',
      default: false,
      exclusive: [
        'cpu-request',
        'cpu-limit',
        'memory-request',
        'memory-limit',
        'dry-run',
      ],
    }),
    'at-next-window': Flags.boolean({
      description:
        'With --apply-proposal: hold the change until the maintenance window that governs the app opens, instead of now. Flui reads the evidence again then.',
      dependsOn: ['apply-proposal'],
      default: false,
    }),
    container: Flags.string({
      description: 'Container to change (default: the first one)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppResources);
    const requests = pick(flags['cpu-request'], flags['memory-request']);
    const limits = pick(flags['cpu-limit'], flags['memory-limit']);
    const changing = Boolean(requests || limits);
    if (flags['dry-run'] && !changing) {
      this.error('--dry-run needs at least one change flag');
    }

    if (flags['apply-proposal'] && flags['at-next-window']) {
      await this.deferProposal(args.name, flags.cluster, flags.output);
      return;
    }
    if (flags['apply-proposal']) {
      await this.applyProposal(args.name, flags.cluster, flags.output);
      return;
    }

    const spinner = ora(
      changing && !flags['dry-run']
        ? `Changing resources of "${args.name}"...`
        : `Reading resources of "${args.name}"...`,
    ).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const change = { requests, limits, containerName: flags.container };

      if (changing) {
        const consequence = await service.resourcesConsequence(app.id, change);
        if (flags['dry-run'] || consequence.problem) {
          spinner.stop();
          if (flags.output === 'json') {
            console.log(JSON.stringify(consequence, null, 2));
          } else {
            printConsequence(consequence);
          }
          if (consequence.problem) process.exitCode = 1;
          return;
        }
        spinner.text = `${consequence.placement.sentence} Changing resources of "${args.name}"...`;
      }

      const runtime = changing
        ? await service.setResources(app.id, change)
        : await service.getRuntime(app.id);

      if (changing) {
        spinner.succeed(
          `Resources of "${args.name}" changed — the application restarts with them`,
        );
      } else {
        spinner.stop();
      }

      const proposal = changing
        ? null
        : await service.resourceProposal(app.id).catch(() => null);
      if (flags.output === 'json') {
        console.log(
          JSON.stringify(
            changing
              ? runtime.containers
              : {
                  containers: runtime.containers,
                  proposal: proposal?.proposal ?? null,
                },
            null,
            2,
          ),
        );
        return;
      }
      print(runtime);
      if (proposal) printProposal(proposal, args.name);
    } catch (error: any) {
      spinner.fail(
        changing ? 'Failed to change resources' : 'Failed to read resources',
      );
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private async deferProposal(
    name: string,
    cluster: string | undefined,
    output: string,
  ): Promise<void> {
    const spinner = ora(
      `Holding the proposal for "${name}" for its maintenance window...`,
    ).start();
    try {
      const { id: clusterId } = await resolveClusterRef(cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(name);
      const held = await service.deferResourceProposal(app.id);
      spinner.succeed(
        `Held until ${new Date(held.runAt).toLocaleString()}. Flui reads the evidence again then; cancel with \`flui app maintenance cancel ${name} ${held.id}\`.`,
      );
      if (output === 'json') console.log(JSON.stringify(held, null, 2));
    } catch (error: any) {
      spinner.fail('Could not hold the proposal');
      console.log(
        chalk.red(
          `\n  Error: ${error.response?.data?.message ?? error.message}\n`,
        ),
      );
      this.exit(1);
    }
  }

  private async applyProposal(
    name: string,
    cluster: string | undefined,
    output: string,
  ): Promise<void> {
    const spinner = ora(`Applying the proposal for "${name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(name);
      const before = await service.resourceProposal(app.id);
      if (!before.proposal) {
        spinner.info(`Nothing to apply: "${name}" fits what it has.`);
        return;
      }
      const after = await service.applyResourceProposal(app.id);
      spinner.succeed(
        `Applied: memory request ${before.proposal.consequence.requests.memory ?? '—'} · limit ${before.proposal.consequence.limits.memory ?? '—'}. The application restarts with them.`,
      );
      if (output === 'json') console.log(JSON.stringify(after, null, 2));
      else if (before.proposal.configurationNote) {
        console.log(chalk.dim(`  ${before.proposal.configurationNote}`));
      }
    } catch (error: any) {
      spinner.fail('Failed to apply the proposal');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}

function pick(
  cpu: string | undefined,
  memory: string | undefined,
): { cpu?: string; memory?: string } | undefined {
  if (cpu === undefined && memory === undefined) return undefined;
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
  };
}

function print(runtime: AppRuntime): void {
  console.log('');
  for (const c of runtime.containers) {
    console.log(`  ${chalk.bold(c.name)}`);
    console.log(
      `    ${chalk.dim('cpu:')}     request ${c.requests.cpu ?? '—'} · limit ${c.limits.cpu ?? '—'}`,
    );
    console.log(
      `    ${chalk.dim('memory:')}  request ${c.requests.memory ?? '—'} · limit ${c.limits.memory ?? '—'}`,
    );
    if (c.usage?.cpu || c.usage?.memory) {
      console.log(
        `    ${chalk.dim('in use:')}  cpu ${c.usage.cpu ?? '—'} · memory ${c.usage.memory ?? '—'}`,
      );
    }
  }
  console.log('');
}

function placementColour(
  verdict: ResourcesConsequence['placement']['verdict'],
): (text: string) => string {
  if (verdict === 'fits') return chalk.green;
  if (verdict === 'nothing-hosts') return chalk.yellow;
  return chalk.cyan;
}

function printConsequence(consequence: ResourcesConsequence): void {
  const { requests, limits, problem, placement } = consequence;
  console.log('');
  console.log(
    `  ${chalk.dim('cpu:')}     request ${requests.cpu ?? '—'} · limit ${limits.cpu ?? '—'}`,
  );
  console.log(
    `  ${chalk.dim('memory:')}  request ${requests.memory ?? '—'} · limit ${limits.memory ?? '—'}`,
  );
  console.log('');
  if (problem) {
    console.log(chalk.red(`  ${problem}`));
    console.log('');
    return;
  }
  const colour = placementColour(placement.verdict);
  console.log(`  ${colour(placement.sentence)}`);
  if (placement.why) console.log(chalk.dim(`  ${placement.why}`));
  if (placement.largest) {
    const { shape, cpuMillicores, memoryMi } = placement.largest;
    const shapeNote = shape ? ` (a ${shape})` : '';
    console.log(
      chalk.dim(
        `  The largest replica anything here could hold: ${memoryMi}Mi and ${cpuMillicores}m${shapeNote}.`,
      ),
    );
  }
  console.log(chalk.dim('  Nothing was written (--dry-run).'));
  console.log('');
}

function printProposal(answer: ResourceProposalAnswer, name: string): void {
  const p = answer.proposal;
  if (!p) {
    if (!answer.usageRead) {
      console.log(
        chalk.dim(
          '  A week of memory use could not be read; only an out-of-memory stop would propose a change.',
        ),
      );
      console.log('');
    }
    return;
  }
  console.log(`  ${chalk.yellow('Flui proposes')} for ${p.containerName}:`);
  for (const r of p.reasons) console.log(`    ${r.sentence}`);
  console.log(
    `    memory: request ${p.currentRequests.memory ?? '—'} → ${p.consequence.requests.memory ?? '—'} · limit ${p.currentLimits.memory ?? '—'} → ${p.consequence.limits.memory ?? '—'}`,
  );
  console.log(`    ${p.consequence.placement.sentence}`);
  console.log(chalk.dim(`    ${p.restart}`));
  if (p.configurationNote) console.log(chalk.dim(`    ${p.configurationNote}`));
  console.log(
    chalk.dim(`    Apply with: flui app resources ${name} --apply-proposal`),
  );
  console.log('');
}
