import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  SnapshotResponse,
  SnapshotListResponse,
} from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { formatBytes } from '../../../lib/format-bytes';

export default class AppSnapshotList extends Command {
  static readonly description =
    'List volume snapshots. ' +
    'Use --app to filter to a single app, omit to list cluster-wide.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --app my-app',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    app: Flags.string({
      char: 'a',
      description: 'Filter by application name or slug',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AppSnapshotList);
    const spinner = ora('Fetching snapshots...').start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);

      let items: SnapshotResponse[];
      let unsupportedReason: string | undefined;
      if (flags.app) {
        const app = await service.getAppByName(flags.app);
        const response: SnapshotListResponse = await service.listAppSnapshots(
          app.id,
        );
        items = response.items;
        if (!response.supported) unsupportedReason = response.reason;
      } else {
        items = await service.listClusterSnapshots();
      }

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (unsupportedReason) {
        console.log(chalk.yellow(`\n  ${unsupportedReason}\n`));
        return;
      }

      if (items.length === 0) {
        console.log(chalk.dim('  No snapshots found.'));
        return;
      }

      console.log('');
      console.log(
        `  ${chalk.bold('EXPORT ID'.padEnd(48))} ${chalk.bold('SINK'.padEnd(12))} ${chalk.bold('REQ'.padEnd(7))} ${chalk.bold('USED'.padEnd(10))} ${chalk.bold('READY'.padEnd(6))} ${chalk.bold('SOURCE PVC')}`,
      );
      console.log('  ' + '─'.repeat(130));
      for (const s of items) {
        const id = s.exportId.padEnd(48).slice(0, 48);
        const sink = s.sink.padEnd(12);
        const size = (s.sizeGb === undefined ? '—' : `${s.sizeGb}Gi`).padEnd(7);
        const used = (
          s.actualBytes === undefined ? '—' : formatBytes(s.actualBytes)
        ).padEnd(10);
        const ready = (s.ready ? chalk.green('OK') : chalk.yellow('..')).padEnd(
          6,
        );
        const src = s.sourcePvcName ?? '—';
        console.log(`  ${id} ${sink} ${size} ${used} ${ready} ${src}`);
      }
      console.log('');
      console.log(chalk.dim(`  ${items.length} snapshot(s) total`));
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to list snapshots');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
