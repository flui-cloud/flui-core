import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { promptMaskedInput } from '../../../lib/prompts';
import { stdinRequested, stdinValue } from '../../../lib/stdin-value';
import { printRegistryStorage, RegistryStorageStatus } from './status';

const SCALEWAY_SETUP_MS = 8 * 60_000;

export default class RegistryStorageConnect extends Command {
  static readonly description =
    "Connect the instance's image registry to a bucket. `scaleway` creates the bucket in a Scaleway project of its own, with a key limited to Object Storage there, using the Scaleway key this installation already holds — nothing to paste. `s3` connects a bucket of your own: give it a key that reaches only that bucket.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> scaleway --region fr-par',
    '<%= config.bin %> <%= command.id %> s3 --provider ovh_object_storage --endpoint https://s3.gra.io.cloud.ovh.net --region gra --bucket flui-registry --access-key AKIA…',
    'printf %s "$SECRET" | <%= config.bin %> <%= command.id %> s3 --endpoint … --region … --bucket … --access-key … --stdin',
  ];

  static readonly args = {
    kind: Args.string({
      description: 'scaleway (created by Flui) or s3 (a bucket of your own)',
      options: ['scaleway', 's3'],
      required: true,
    }),
  };

  static readonly flags = {
    region: Flags.string({
      description: 'Region of the bucket',
      required: true,
    }),
    provider: Flags.string({
      description: 'For s3: who hosts the bucket',
      options: [
        'ovh_object_storage',
        'scaleway_object_storage',
        'generic_s3',
        'minio',
      ],
      default: 'generic_s3',
    }),
    endpoint: Flags.string({ description: 'For s3: the S3 endpoint URL' }),
    bucket: Flags.string({ description: 'For s3: the bucket name' }),
    prefix: Flags.string({
      description: 'For s3: folder inside the bucket',
      default: 'zot',
    }),
    'force-path-style': Flags.boolean({
      description: 'For s3: path-style addressing',
    }),
    'access-key': Flags.string({ description: 'For s3: the access key id' }),
    stdin: Flags.boolean({
      description:
        'For s3: read the secret key from standard input instead of prompting',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RegistryStorageConnect);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });

    if (args.kind === 'scaleway') {
      const spinner = ora(
        'Creating the registry project, its key and its bucket on Scaleway (permissions can take a few minutes to apply)…',
      ).start();
      try {
        const status = await api.post<RegistryStorageStatus>(
          '/registry/storage/scaleway',
          { region: flags.region },
          { timeoutMs: SCALEWAY_SETUP_MS },
        );
        spinner.succeed('Registry bucket ready on Scaleway.');
        printRegistryStorage(status);
      } catch (error) {
        spinner.fail('The registry bucket could not be created.');
        this.error((error as Error).message, { exit: 1 });
      }
      return;
    }

    for (const required of ['endpoint', 'bucket', 'access-key'] as const) {
      if (!flags[required])
        this.error(`--${required} is required for s3`, { exit: 2 });
    }
    const secretKey = stdinRequested()
      ? stdinValue()
      : await promptMaskedInput('Secret key');
    if (!secretKey) this.error('The secret key is empty.', { exit: 2 });

    const spinner = ora(
      'Checking that the key can write to the bucket…',
    ).start();
    try {
      const status = await api.post<RegistryStorageStatus>(
        '/registry/storage',
        {
          provider: flags.provider,
          endpoint: flags.endpoint,
          region: flags.region,
          bucket: flags.bucket,
          prefix: flags.prefix,
          forcePathStyle: flags['force-path-style'],
          accessKey: flags['access-key'],
          secretKey,
        },
      );
      spinner.succeed('Registry bucket connected.');
      printRegistryStorage(status);
    } catch (error) {
      spinner.fail('The bucket could not be connected.');
      this.error((error as Error).message, { exit: 1 });
    }
    console.log(
      chalk.dim(
        '  Flui keeps the key sealed; it is written only into the registry configuration.\n',
      ),
    );
  }
}
