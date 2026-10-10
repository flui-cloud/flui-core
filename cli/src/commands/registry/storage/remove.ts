import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { confirmPrompt } from '../../../lib/prompts';
import { RegistryBucket } from './list';

const REMOVAL_MS = 10 * 60_000;

export default class RegistryStorageRemove extends Command {
  static readonly description =
    'Remove a bucket the image registry no longer uses. A bucket Flui created is deleted with the images in it and the key made for it; a bucket of your own is only forgotten, its content stays.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 3f2c…',
    '<%= config.bin %> <%= command.id %> 3f2c… --yes',
  ];

  static readonly args = {
    id: Args.string({
      required: true,
      description: 'Bucket id, from `flui registry storage list`',
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RegistryStorageRemove);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const target = (
      await api.get<RegistryBucket[]>('/registry/storage/buckets')
    ).find((b) => b.id === args.id);
    if (!target) this.error(`No registry bucket ${args.id}`);

    if (!flags.yes) {
      const what = target.createdByFlui
        ? `Delete bucket ${target.bucket} with every image in it, and the key Flui made for it?`
        : `Forget bucket ${target.bucket}? Its content is not removed.`;
      if (!(await confirmPrompt(chalk.yellow(what), false))) {
        this.log(chalk.green('Cancelled'));
        return;
      }
    }

    const spinner = ora(`Removing ${target.bucket}…`).start();
    try {
      const done = await api.delete<{ bucket: string; bucketDeleted: boolean }>(
        `/registry/storage/buckets/${encodeURIComponent(args.id)}`,
        { timeout: REMOVAL_MS },
      );
      spinner.succeed(
        done.bucketDeleted
          ? `Deleted ${done.bucket} and what Flui created for it.`
          : `Forgot ${done.bucket}; its content is still there.`,
      );
    } catch (err) {
      spinner.fail(`Removal failed: ${(err as Error).message}`);
      this.exit(1);
    }
  }
}
