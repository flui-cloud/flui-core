import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

export interface RegistryStorageStatus {
  backend: 'filesystem' | 's3';
  connected: boolean;
  provider?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  connectedAt?: string;
  usage?: RegistryUsage;
}

export interface RegistryUsage {
  measuredAt: string;
  totalBytes: number;
  alertBytes: number | null;
  capacityBytes: number | null;
  alerting: boolean;
  applications: Array<{ applicationId: string; name: string; bytes: number }>;
  unreadable: number;
}

const gib = (bytes: number): string =>
  bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

function printUsage(usage: RegistryUsage): void {
  const of =
    usage.capacityBytes === null ? '' : ` of ${gib(usage.capacityBytes)}`;
  const line = `${gib(usage.totalBytes)}${of}`;
  console.log(
    `  ${chalk.bold('Space in use:')}   ${usage.alerting ? chalk.yellow(line) : line}`,
  );
  console.log(
    `  ${chalk.bold('Alert at:')}       ${usage.alertBytes === null ? 'off' : gib(usage.alertBytes)}`,
  );
  console.log(
    chalk.dim(`  Measured ${new Date(usage.measuredAt).toLocaleString()}`),
  );
  const top = usage.applications.slice(0, 10);
  if (top.length > 0) {
    console.log('');
    console.log(`  ${chalk.bold('Largest applications')}`);
    for (const app of top) {
      console.log(`    ${gib(app.bytes).padStart(10)}  ${app.name}`);
    }
    if (usage.applications.length > top.length) {
      console.log(
        chalk.dim(`    …and ${usage.applications.length - top.length} more`),
      );
    }
    console.log(
      chalk.dim(
        '    A layer two applications share counts in both; the total counts it once.',
      ),
    );
  }
  if (usage.unreadable > 0) {
    console.log(
      chalk.yellow(
        `  The images of ${usage.unreadable} application(s) could not be read on this pass.`,
      ),
    );
  }
  if (usage.alerting) {
    console.log(
      chalk.yellow(
        '\n  Over the space alert: delete old versions or unused applications, or keep fewer versions per application.',
      ),
    );
  }
}

export function printRegistryStorage(status: RegistryStorageStatus): void {
  const where =
    status.backend === 's3'
      ? 'object storage'
      : 'a volume on the control cluster';
  console.log('');
  console.log(`  ${chalk.bold('Images kept on:')} ${where}`);
  if (status.usage) printUsage(status.usage);
  console.log('');
  if (status.connected) {
    console.log(`  ${chalk.bold('Bucket:')}         ${status.bucket}`);
    console.log(`  ${chalk.bold('Provider:')}       ${status.provider}`);
    console.log(`  ${chalk.bold('Region:')}         ${status.region}`);
    console.log(`  ${chalk.bold('Endpoint:')}       ${status.endpoint}`);
  } else {
    console.log(chalk.dim('  No bucket connected.'));
  }
  if (status.backend === 's3' && !status.connected) {
    console.log(
      chalk.yellow(
        '\n  The registry is set to object storage and waits for a bucket: run `flui registry storage connect scaleway --region fr-par`.',
      ),
    );
  }
  if (status.backend === 'filesystem' && status.connected) {
    console.log(
      chalk.dim(
        '\n  The bucket is connected but not in use: the registry moves to it once the installation is set to object storage.',
      ),
    );
  }
  console.log('');
}

export default class RegistryStorageStatusCommand extends Command {
  static readonly description =
    "Show where the instance's image registry keeps images, the space they take, and which bucket it is connected to.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --measure',
  ];

  static readonly flags = {
    json: Flags.boolean({ description: 'Print the raw status as JSON' }),
    measure: Flags.boolean({
      description:
        'Measure the space now instead of showing the last measurement (taken every 30 minutes)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RegistryStorageStatusCommand);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const status = await api.get<RegistryStorageStatus>(
      flags.measure ? '/registry/storage?measure=true' : '/registry/storage',
    );
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    printRegistryStorage(status);
  }
}
