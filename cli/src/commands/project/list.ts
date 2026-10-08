import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ProjectClient, ProjectItem } from '../../lib/project-client';
import { printContextBanner } from '../../lib/context-banner';

export default class ProjectList extends Command {
  static readonly description =
    'Projects you can create applications in. Pass one to flui deploy or flui catalog install with --project; without it, a new application goes to your personal project.';
  static readonly examples = ['<%= config.bin %> <%= command.id %>'];
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProjectList);
    printContextBanner();

    const projects = await ProjectClient.fromConfig().list();
    if (flags.json) {
      this.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      this.log(
        chalk.yellow(
          '\n   No projects yet. Your first application creates your personal one.\n',
        ),
      );
      return;
    }

    this.log('');
    for (const project of projects as ProjectItem[]) {
      const personal = project.ownerUserId ? chalk.dim('  personal') : '';
      this.log(
        `   ${chalk.bold(project.name)}  ${chalk.dim(project.slug)}${personal}`,
      );
    }
    this.log('');
  }
}
