import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ProjectClient } from '../../lib/project-client';
import { printContextBanner } from '../../lib/context-banner';

export default class ProjectCreate extends Command {
  static readonly description =
    'Create a project. Its applications share a space on each cluster, so they reach each other and their building blocks. The short name (slug) is fixed at creation; the name can be changed later.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> "Web team"',
    '<%= config.bin %> <%= command.id %> "Web team" --description "Public site and its API"',
  ];
  static readonly args = {
    name: Args.string({ description: 'Project name', required: true }),
  };
  static readonly flags = {
    description: Flags.string({ description: 'What the project is for' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProjectCreate);
    if (!flags.json) printContextBanner();
    const project = await ProjectClient.fromConfig().create({
      name: args.name,
      description: flags.description,
    });
    if (flags.json) {
      this.log(JSON.stringify(project, null, 2));
      return;
    }
    this.log(
      `\n   Created ${chalk.bold(project.name)}  ${chalk.dim(project.slug)}`,
    );
    this.log(chalk.dim(`   Deploy into it with --project ${project.slug}\n`));
  }
}
