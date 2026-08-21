import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CatalogApp, CatalogClient } from '../../lib/catalog-client';
import { printContextBanner } from '../../lib/context-banner';

function row(a: CatalogApp): string {
  return (
    `   ${chalk.bold(a.slug.padEnd(22))} ${a.name.padEnd(24)} ` +
    `${chalk.dim(a.category.padEnd(14))} ${chalk.dim(a.version)}`
  );
}

export default class CatalogList extends Command {
  static readonly description =
    'List the applications this instance can install';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --search umami',
    '<%= config.bin %> <%= command.id %> --building-blocks',
  ];
  static readonly flags = {
    search: Flags.string({ description: 'Filter by name or description' }),
    category: Flags.string({ description: 'Filter by category' }),
    'building-blocks': Flags.boolean({
      default: false,
      description:
        'List databases, caches and queues instead — the dependencies `/catalog` hides',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CatalogList);
    printContextBanner();

    const catalog = CatalogClient.fromConfig();
    const apps = flags['building-blocks']
      ? await catalog.listBuildingBlocks()
      : await catalog.list({
          search: flags.search,
          category: flags.category,
        });

    if (flags.json) {
      this.log(JSON.stringify(apps, null, 2));
      return;
    }

    if (apps.length === 0) {
      this.log(chalk.yellow('\n   Nothing in the catalog matches.\n'));
      return;
    }

    this.log('');
    for (const a of apps) this.log(row(a));
    this.log(
      chalk.dim(`\n   ${apps.length} apps · flui catalog install <slug>\n`),
    );
  }
}
