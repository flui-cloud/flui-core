import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface RegistryTraffic {
  window: string;
  requests: { pulls: number; pushes: number; deletes: number };
  outcomes: { ok: number; refused: number; notFound: number; failed: number };
  bytesIn: number;
  bytesOut: number;
  peakBytesPerSecondIn: number;
  peakBytesPerSecondOut: number;
  readFromBucketBytes: number | null;
}

const size = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const rate = (bytesPerSecond: number): string =>
  `${((bytesPerSecond * 8) / 1_000_000).toFixed(1)} Mbit/s`;

export default class RegistryTrafficCommand extends Command {
  static readonly description =
    "Show what the installation's image registry carried: pulls and pushes, refusals and failures, bytes in and out, and the busiest five minutes.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --window 7d',
  ];

  static readonly flags = {
    window: Flags.string({
      description: 'Period to read',
      options: ['1h', '24h', '7d', '30d'],
      default: '24h',
    }),
    json: Flags.boolean({ description: 'Print the raw figures as JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RegistryTrafficCommand);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const t = await api.get<RegistryTraffic>(
      `/registry/traffic?window=${flags.window}`,
    );
    if (flags.json) {
      console.log(JSON.stringify(t, null, 2));
      return;
    }
    const line = (label: string, value: string) =>
      console.log(`  ${chalk.bold(label.padEnd(16))}${value}`);
    console.log('');
    console.log(chalk.dim(`  Last ${t.window}`));
    line('Pulls:', String(t.requests.pulls));
    line('Pushes:', String(t.requests.pushes));
    line('Pulled out:', size(t.bytesOut));
    line('Pushed in:', size(t.bytesIn));
    line(
      'Busiest 5 min:',
      `${rate(t.peakBytesPerSecondOut)} out, ${rate(t.peakBytesPerSecondIn)} in`,
    );
    const { refused, failed, notFound } = t.outcomes;
    line(
      'Refused:',
      refused > 0 ? chalk.yellow(String(refused)) : String(refused),
    );
    line('Failed:', failed > 0 ? chalk.red(String(failed)) : String(failed));
    line('Not found:', String(notFound));
    if (t.readFromBucketBytes !== null) {
      console.log(
        chalk.dim(
          `\n  ${size(t.readFromBucketBytes)} read from the bucket to serve pulls: the provider may bill it as outgoing traffic.`,
        ),
      );
    }
    if (refused > 0) {
      console.log(
        chalk.dim(
          '  Refused means over an application quota, an upload too large, or over the rate limit.',
        ),
      );
    }
    console.log('');
  }
}
