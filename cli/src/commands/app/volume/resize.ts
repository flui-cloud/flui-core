import { Command, Flags, Args } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

/**
 * Asking first, always.
 *
 * The plan is fetched before anything is sent, because on most clusters the
 * answer is no and the reason is worth reading: Flui's default storage keeps an
 * application's data in a folder on the machine, where the size written on a
 * volume is not a limit and there is nothing to raise. Printing that instead of
 * an API error is the whole point of the round trip.
 */
export default class AppVolumeResize extends Command {
  static readonly description =
    "Make an application's volume bigger. Volumes only ever grow.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app --volume data-my-app-postgres-0 --size 50',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    volume: Flags.string({
      char: 'v',
      description:
        'Which volume to grow. Only needed when the application has more than one.',
    }),
    size: Flags.integer({
      char: 's',
      description: 'New size in GiB. Omit to just see what is possible.',
    }),
    output: Flags.string({
      char: 'o',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppVolumeResize);
    const spinner = ora('Looking at the volumes...').start();

    let service: CliAppService;
    let appId: string;
    let plan: Awaited<ReturnType<CliAppService['appVolumeResizePlan']>>;
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.app);
      appId = app.id;
      plan = await service.appVolumeResizePlan(appId);
      spinner.stop();
    } catch (error) {
      spinner.fail((error as Error).message);
      this.exit(1);
      return;
    }

    if (flags.output === 'json' && flags.size === undefined) {
      this.log(JSON.stringify(plan, null, 2));
      return;
    }

    if (plan.length === 0) {
      this.log('');
      this.log(chalk.dim('   This application has no volumes.'));
      this.log('');
      return;
    }

    if (flags.size === undefined) {
      this.printPlan(plan);
      return;
    }

    const target = this.pick(plan, flags.volume);
    if (!target) return;

    if (!target.canGrow) {
      this.log('');
      this.log(
        `   ${chalk.yellow('Cannot grow')} ${chalk.bold(target.volumeName)}`,
      );
      this.log('');
      this.log(`   ${target.reason ?? 'No reason given.'}`);
      this.log('');
      this.exit(1);
      return;
    }

    const run = ora(
      `Growing ${target.volumeName} to ${flags.size}GiB...`,
    ).start();
    try {
      const result = await service.resizeAppVolume(
        appId,
        target.volumeName,
        flags.size,
      );
      const headline = `${result.volumeName}: ${result.from ?? '?'} → ${chalk.bold(result.to)}`;
      // "Asked for" rather than "done" when the storage has not caught up:
      // a class can accept the new number and never act on it, and a tick next
      // to an unchanged volume is worse than no answer at all.
      if (result.outcome === 'applied') {
        run.succeed(headline);
      } else {
        run.warn(headline);
      }
      this.log('');
      this.log(`   ${result.message}`);
      if (result.restartRequired) {
        this.log(chalk.dim(`   Restart it with: flui app restart ${args.app}`));
      }
      this.log('');
    } catch (error) {
      run.fail((error as Error).message);
      this.exit(1);
    }
  }

  private printPlan(
    plan: Awaited<ReturnType<CliAppService['appVolumeResizePlan']>>,
  ): void {
    this.log('');
    this.log(`   ${chalk.bold('Volumes')}`);
    for (const v of plan) {
      const mark = v.canGrow ? chalk.green('can grow') : chalk.yellow('fixed');
      this.log(
        `     ${v.volumeName.padEnd(38)} ${(v.current ?? '?').padStart(7)}  ${mark}`,
      );
      if (!v.canGrow && v.reason) {
        this.log(chalk.dim(`       ${v.reason}`));
      }
    }
    this.log('');
    if (plan.some((v) => v.canGrow)) {
      this.log(chalk.dim('   Pass --size <GiB> to grow one.'));
      this.log('');
    }
  }

  private pick(
    plan: Awaited<ReturnType<CliAppService['appVolumeResizePlan']>>,
    wanted?: string,
  ): (typeof plan)[number] | undefined {
    if (wanted) {
      const found = plan.find((v) => v.volumeName === wanted);
      if (!found) {
        this.log('');
        this.log(
          chalk.red(`   No volume named "${wanted}" on this application.`),
        );
        this.printPlan(plan);
        this.exit(1);
      }
      return found;
    }

    if (plan.length === 1) return plan[0];

    this.log('');
    this.log(
      chalk.yellow(
        '   This application has more than one volume — say which with --volume.',
      ),
    );
    this.printPlan(plan);
    this.exit(1);
    return undefined;
  }
}
