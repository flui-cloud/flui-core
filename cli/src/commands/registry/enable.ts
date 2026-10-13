import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';
import {
  RegistryModeStatus,
  RegistryStorageChoice,
  defaultStorage,
  waitForRegistry,
} from '../../lib/registry-mode-view';
import { printRegistryMode } from './status';

const ENABLE_MS = 3 * 60_000;
const READY_MS = 5 * 60_000;
const POLL_MS = 5_000;

function chosenStorage(
  requested: RegistryStorageChoice | undefined,
  current: RegistryModeStatus,
): RegistryStorageChoice {
  return (
    requested ??
    (current.mode === 'flui' && current.storage
      ? current.storage
      : defaultStorage(current))
  );
}

function confirmEnable(storage: RegistryStorageChoice): Promise<boolean> {
  const where =
    storage === 's3'
      ? 'the connected bucket'
      : 'a volume on the control cluster';
  return confirmPrompt(
    chalk.yellow(
      `Run the Flui registry, keeping images on ${where}, and send new builds to it? Running applications keep their current images.`,
    ),
    false,
  );
}

export default class RegistryEnable extends Command {
  static readonly description =
    'Send new builds to the registry Flui runs on the control cluster, instead of GitHub Container Registry. Applications already running keep their current images. With --storage s3, connect a bucket first with `flui registry storage connect`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --storage volume --yes',
    '<%= config.bin %> <%= command.id %> --storage s3',
  ];

  static readonly flags = {
    storage: Flags.string({
      description:
        'Where the registry keeps images: volume (on the control cluster) or s3 (the connected bucket). Default: s3 when a bucket is connected, else volume',
      options: ['volume', 's3'],
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return once the registry is starting, without waiting',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RegistryEnable);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });

    const current = await api.get<RegistryModeStatus>('/registry/mode');
    const storage = chosenStorage(
      flags.storage as RegistryStorageChoice | undefined,
      current,
    );

    if (
      current.mode === 'flui' &&
      current.ready &&
      current.storage === storage
    ) {
      this.log(chalk.green('New builds already push to the Flui registry.'));
      printRegistryMode(current);
      return;
    }
    if (storage === 's3' && !current.bucketConnected) {
      this.error(
        'No bucket is connected for the registry. Run `flui registry storage connect scaleway --region fr-par` (or connect a bucket of your own) first, or use --storage volume.',
        { exit: 2 },
      );
    }

    if (!flags.yes && !(await confirmEnable(storage))) {
      this.log(chalk.green('Cancelled'));
      return;
    }

    const spinner = ora('Putting the Flui registry in place…').start();
    let status: RegistryModeStatus;
    try {
      status = await api.post<RegistryModeStatus>(
        '/registry/enable',
        { storage },
        { timeoutMs: ENABLE_MS },
      );
    } catch (error) {
      spinner.fail('The Flui registry was not turned on.');
      this.error((error as Error).message, { exit: 1 });
    }

    if (!status.ready && !flags['no-wait']) {
      spinner.text = 'Waiting for the registry to start…';
      status = await waitForRegistry(
        () => api.get<RegistryModeStatus>('/registry/mode'),
        { timeoutMs: READY_MS, intervalMs: POLL_MS },
      );
    }
    if (status.ready) {
      spinner.succeed('New builds now push to the Flui registry.');
    } else {
      spinner.warn(
        'New builds now push to the Flui registry; it is still starting. Check with `flui registry status`.',
      );
    }
    printRegistryMode(status);
  }
}
