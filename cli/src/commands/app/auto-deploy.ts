import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

/**
 * Reading and changing a policy that, until now, no surface could show.
 *
 * It decides whether the platform keeps the application on the newest
 * successful build of its branch. That matters most when it is on and you did
 * not know: a version deployed by hand is not refused, it is quietly replaced
 * by the next reconcile, which reads as "the rollback did not work".
 */
export default class AppAutoDeploy extends Command {
  static readonly description =
    'Show or change whether an application redeploys itself from its branch';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --off',
    '<%= config.bin %> <%= command.id %> my-api --on',
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
    on: Flags.boolean({
      description: 'Follow the branch: every successful build is rolled out',
      exclusive: ['off'],
    }),
    off: Flags.boolean({
      description: 'Stop following the branch: releases become manual',
      exclusive: ['on'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppAutoDeploy);
    const wanted = flags.on ? true : flags.off ? false : null;
    const spinner = ora(
      wanted === null
        ? `Reading auto-deploy for "${args.name}"...`
        : `Turning auto-deploy ${wanted ? 'on' : 'off'} for "${args.name}"...`,
    ).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const listed = await service.getAppByName(args.name);
      // Re-read in full: the cluster listing does not carry deployOnPush, and a
      // missing field would be reported as "off" — the wrong answer, silently.
      const app = await service.getApp(listed.id);
      if (app.deployOnPush === undefined) {
        throw new Error(
          `This installation did not report deployOnPush for "${args.name}". ` +
            'It is too old to know the policy; upgrade it before trusting an answer here.',
        );
      }

      if (wanted === null) {
        spinner.stop();
        this.report(args.name, app.deployOnPush === true);
        return;
      }

      if (app.deployOnPush === wanted) {
        spinner.info(
          `Auto-deploy is already ${wanted ? 'on' : 'off'} for "${args.name}"`,
        );
        return;
      }

      const updated = await service.setDeployOnPush(app.id, wanted);
      spinner.succeed(
        `Auto-deploy ${wanted ? 'on' : 'off'} for "${args.name}"`,
      );
      this.report(args.name, updated.deployOnPush === true);
    } catch (error: any) {
      spinner.fail('Failed to read or change auto-deploy');
      this.error(error.message);
    }
  }

  private report(name: string, on: boolean): void {
    console.log('');
    console.log(
      `  ${chalk.bold('Auto-deploy:')}  ${
        on
          ? chalk.yellow('on — follows the branch')
          : chalk.green('off — manual releases')
      }`,
    );
    console.log('');
    console.log(
      on
        ? chalk.dim(
            `  Every successful build of the branch is rolled out. A version you deploy by\n` +
              `  hand is replaced at the next reconcile, so turn this off before pinning one:\n` +
              `    flui app auto-deploy ${name} --off`,
          )
        : chalk.dim(
            `  New builds are recorded but not rolled out. Deploy a version when you want it:\n` +
              `    flui app versions ${name}`,
          ),
    );
    console.log('');
  }
}
