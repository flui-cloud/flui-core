import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';

export default class AppImageDelete extends Command {
  static readonly description =
    'Delete a container image version from the registry (GHCR). ' +
    'Refuses to delete the currently deployed version. The latest-release guard can be overridden with --force.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api 845914920',
    '<%= config.bin %> <%= command.id %> my-api 845914920 --force',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    versionId: Args.integer({
      description:
        'GitHub Packages numeric version id (from `flui app versions --output json`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({ char: 'c' }),
    force: Flags.boolean({
      description:
        'Override the latest-release guard. The currently-deployed guard is never bypassable.',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppImageDelete);

    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Permanently delete GHCR version ${args.versionId} for "${args.name}"?`,
        false,
      );
      if (!ok) {
        console.log(chalk.dim('  Aborted.'));
        return;
      }
    }

    const spinner = ora(`Deleting version ${args.versionId}...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      await service.deleteImageVersion(app.id, args.versionId, {
        force: flags.force,
      });
      spinner.succeed(`Deleted GHCR version ${args.versionId}`);
    } catch (error: any) {
      spinner.fail('Delete failed');
      const msg: string = error.message ?? '';
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      if (/latest release/i.test(msg) && !flags.force) {
        console.log(
          chalk.dim(
            '  Re-run with --force to override the latest-release guard.\n',
          ),
        );
      }
      if (/delete:packages/i.test(msg)) {
        console.log(
          chalk.dim(
            '  Your GHCR PAT must be a classic token with read:packages + delete:packages scopes.\n',
          ),
        );
      }
      this.exit(1);
    }
  }
}
