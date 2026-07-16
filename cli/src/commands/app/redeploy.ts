import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppRedeploy extends Command {
  static readonly description =
    'Redeploy an application from an existing image (tag or digest), without rebuilding';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api a1cac27',
    '<%= config.bin %> <%= command.id %> my-api sha256:812bdfd0a833...',
    '<%= config.bin %> <%= command.id %> my-api --build <buildId>',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    target: Args.string({
      description: 'Tag, short digest (12+ hex), or full sha256:<digest>',
      required: false,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({ char: 'c' }),
    build: Flags.string({
      description:
        'Deploy from an existing build id (alternative to tag/digest)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppRedeploy);

    if (!flags.build && !args.target) {
      this.error('Provide either a tag/digest argument or --build <buildId>.');
    }

    const spinner = ora(`Triggering redeploy for "${args.name}"...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);

      if (flags.build) {
        await service.deployFromBuild(app.id, flags.build);
        spinner.succeed(
          `Redeploy triggered for ${app.name} from build ${flags.build}`,
        );
        return;
      }

      await service.redeployTag(app.id, args.target);
      spinner.succeed(
        `Redeploy triggered for ${app.name} with image "${args.target}"`,
      );
      console.log(
        chalk.dim(
          `\n  Run "flui app release ${args.name} --watch" to follow rollout.\n`,
        ),
      );
    } catch (error: any) {
      spinner.fail('Redeploy failed');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
