import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ShowcaseClient, ShowcaseItem } from '../../lib/showcase-client';
import { printContextBanner } from '../../lib/context-banner';

export function since(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

export default class ShowcaseList extends Command {
  static readonly description = 'Applications published to the showcase';
  static readonly examples = ['<%= config.bin %> <%= command.id %>'];
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(ShowcaseList);
    printContextBanner();

    const items = await ShowcaseClient.fromConfig().list();
    if (flags.json) {
      this.log(JSON.stringify(items, null, 2));
      return;
    }

    if (items.length === 0) {
      this.log(
        chalk.yellow(
          '\n   The showcase is empty. Publish something with: flui showcase add <app>\n',
        ),
      );
      return;
    }

    this.log('');
    for (const item of items as ShowcaseItem[]) {
      this.log(
        `   ${chalk.bold(item.name)}  ${chalk.dim(item.slug)}  ` +
          `${item.status === 'running' ? chalk.green(item.status) : chalk.yellow(item.status)}`,
      );
      this.log(`     running here  ${since(item.runningSince)}`);
      if (item.note) this.log(`     says          ${item.note}`);
      if (item.url) this.log(`     answers at    ${chalk.cyan(item.url)}`);
    }
    this.log('');
  }
}
