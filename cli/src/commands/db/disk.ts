import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface DbDiskInfo {
  available: boolean;
  reason: string | null;
  engine: string | null;
  mountPath: string | null;
  used_bytes: number | null;
  size_bytes: number | null;
  available_bytes: number | null;
  utilization_percent: number | null;
  alert_level: 'none' | 'warning' | 'critical';
}

function human(bytes: number | null): string {
  if (bytes === null) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export default class DbDisk extends Command {
  static readonly description =
    'Show disk usage for a Flui database, with a near-full alert.\n' +
    'Reports the fullness of the filesystem hosting the volume — the point at which the\n' +
    'database runs out of space.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> <app-id>'];

  static readonly args = {
    app: Args.string({
      description: 'Application id (see `flui app list`)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(DbDisk);
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.');
    }
    const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });

    const spinner = ora('Fetching disk usage…').start();
    let d: DbDiskInfo;
    try {
      d = await api.get<DbDiskInfo>(`/applications/${args.app}/db-disk`);
    } catch (e) {
      spinner.fail('Failed to fetch disk usage.');
      this.error(e instanceof Error ? e.message : String(e));
    }
    spinner.stop();

    if (!d.available) {
      this.log(d.reason ?? 'No disk usage available for this app.');
      return;
    }

    let color = chalk.green;
    if (d.alert_level === 'critical') color = chalk.red;
    else if (d.alert_level === 'warning') color = chalk.yellow;
    const pct =
      d.utilization_percent === null
        ? ''
        : color(`(${d.utilization_percent.toFixed(1)}%)`);

    const engineSuffix = d.engine ? ` (${d.engine})` : '';
    this.log(chalk.cyan(`\n  Disk hosting this database${engineSuffix}`));
    this.log(
      `    used   ${human(d.used_bytes)} / ${human(d.size_bytes)}  ${pct}`,
    );
    this.log(`    free   ${human(d.available_bytes)}`);
    this.log(`    mount  ${d.mountPath ?? 'n/a'}`);
    this.log(`    status ${color(d.alert_level)}`);
    if (d.alert_level !== 'none') {
      this.log(
        color(
          `    ⚠ The disk hosting this database is ${d.alert_level === 'critical' ? 'almost full' : 'getting full'} — free space or grow the node disk soon.`,
        ),
      );
    }
  }
}
