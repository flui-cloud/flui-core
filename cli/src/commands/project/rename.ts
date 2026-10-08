import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { ProjectClient } from '../../lib/project-client';
import { printContextBanner } from '../../lib/context-banner';

export default class ProjectRename extends Command {
  static readonly description =
    'Give a project a new name. Its short name (slug) and where its applications run do not change.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web-team "Web and mobile"',
  ];
  static readonly args = {
    project: Args.string({
      description: 'Project slug, id or name',
      required: true,
    }),
    name: Args.string({ description: 'New name', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ProjectRename);
    printContextBanner();
    const client = ProjectClient.fromConfig();
    const project = await client.rename(
      await client.resolveId(args.project),
      args.name,
    );
    this.log(
      `\n   Renamed to ${chalk.bold(project.name)}  ${chalk.dim(project.slug)}\n`,
    );
  }
}
