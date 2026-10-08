import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ProjectClient } from '../../lib/project-client';
import { printContextBanner } from '../../lib/context-banner';

export default class ProjectDelete extends Command {
  static readonly description =
    'Delete a project that holds no applications, and its space on every cluster. Refused while it still holds applications, or while a cluster where it has a space does not answer.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web-team --yes',
  ];
  static readonly args = {
    project: Args.string({
      description: 'Project slug, id or name',
      required: true,
    }),
  };
  static readonly flags = {
    yes: Flags.boolean({
      description: 'Do not ask for confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProjectDelete);
    printContextBanner();
    if (!flags.yes) {
      this.error(
        `Deleting a project cannot be undone. Run again with --yes to delete ${args.project}.`,
      );
    }
    const client = ProjectClient.fromConfig();
    await client.remove(await client.resolveId(args.project));
    this.log(`\n   Deleted ${chalk.bold(args.project)}\n`);
  }
}
