import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

const TARGET_KINDS = [
  'cluster',
  'namespace',
  'application',
  'observability',
] as const;
const STRATEGIES = ['velero_rebuild', 'os_snapshot'] as const;

export default class BackupRestoreCreate extends Command {
  static readonly description = 'Create a restore job';
  static readonly flags = {
    artifact: Flags.string({
      required: true,
      description: 'Backup artifact ID',
    }),
    'source-destination': Flags.string({ required: true }),
    'target-cluster': Flags.string({
      required: true,
      description: 'Cluster to restore into',
    }),
    'target-kind': Flags.string({ required: true, options: [...TARGET_KINDS] }),
    'target-namespace': Flags.string({
      description: 'Required when --target-kind=namespace',
    }),
    'target-app': Flags.string({
      description: 'Required when --target-kind=application',
    }),
    'map-namespace': Flags.string({
      multiple: true,
      description:
        'Remap a namespace on restore: "source:target" (repeatable). Enables a same-cluster restore into a new namespace.',
    }),
    strategy: Flags.string({ options: [...STRATEGIES] }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupRestoreCreate);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const selector: Record<string, any> = {};
    if (flags['target-namespace']) {
      selector.namespaces = [flags['target-namespace']];
    }
    if (flags['target-app']) {
      selector.applicationId = flags['target-app'];
    }
    if (flags['map-namespace']?.length) {
      selector.namespaceMapping = Object.fromEntries(
        flags['map-namespace'].map((m) => {
          const [src, dst] = m.split(':');
          if (!src || !dst) {
            throw new Error(
              `--map-namespace expects "source:target", got "${m}"`,
            );
          }
          return [src, dst];
        }),
      );
    }
    const targetSelector = Object.keys(selector).length ? selector : undefined;
    const spinner = ora('Creating restore job...').start();
    try {
      const r = await client.createRestore({
        artifactId: flags.artifact,
        sourceDestinationId: flags['source-destination'],
        targetClusterId: flags['target-cluster'],
        targetKind: flags['target-kind'],
        targetSelector,
        strategy: flags.strategy,
      });
      spinner.succeed(
        `Created restore ${chalk.cyan(r.id)} (status=${r.status})`,
      );
    } catch (err) {
      spinner.fail(`Create failed: ${(err as Error).message}`);
      this.exit(1);
    }
  }
}
