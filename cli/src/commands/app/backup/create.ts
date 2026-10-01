import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  BackupDestinationInput,
  BackupResponse,
  StartedBackup,
} from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { formatBytes } from '../../../lib/format-bytes';
import { renderCopyRefusal } from '../../../lib/render-copy-refusal';

export default class AppBackupCreate extends Command {
  static readonly description =
    'Back up an application volume to S3-compatible object storage. ' +
    'With --destination (a registered destination) the volume becomes a kopia snapshot: encrypted, deduplicated, ' +
    'kept until you delete it, and restorable whole or file by file with `flui app backup restore`. ' +
    'With --bucket a full plaintext copy is archived instead; when both are omitted the cluster provider auto-provisions a bucket ' +
    '(Scaleway: full-auto using your compute key; Hetzner: requires Object ' +
    'Storage credentials connected). Otherwise pass an explicit endpoint + ' +
    '--bucket and S3 credentials via flags or FLUI_S3_ACCESS_KEY/FLUI_S3_SECRET_KEY env. ' +
    'The backup runs in the background: the command follows it to the end unless --no-wait is given.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app --description nightly',
    '<%= config.bin %> <%= command.id %> my-app -D <destId> --no-wait',
    '<%= config.bin %> <%= command.id %> my-app -b external-bucket -e https://s3.eu-central-1.amazonaws.com -r eu-central-1',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    volume: Flags.string({
      char: 'v',
      description:
        'Volume (PVC) name when the app has multiple volumes. Required if more than one PVC exists.',
    }),
    description: Flags.string({
      char: 'd',
      description: 'Optional human-friendly tag appended to the key prefix',
    }),
    pause: Flags.boolean({
      default: false,
      description:
        'Stop the workloads holding the volume, copy it at rest, then start ' +
        'them again. A deliberate outage for the length of the copy.',
      exclusive: ['allow-inconsistent'],
    }),
    'allow-inconsistent': Flags.boolean({
      default: false,
      description:
        'Copy even though the volume holds a database that is being written to. ' +
        'The copy may not restore cleanly.',
    }),
    destination: Flags.string({
      char: 'D',
      description:
        'Registered backup destination id (see `flui backup destination list`). Preferred: the copy is recorded against it and shows up in `flui backup list`.',
      exclusive: ['bucket'],
    }),
    bucket: Flags.string({
      char: 'b',
      description:
        'Destination S3 bucket name. Omit to auto-provision via the cluster provider.',
    }),
    endpoint: Flags.string({
      char: 'e',
      description:
        'S3 endpoint URL (required when --bucket is set). Examples: ' +
        'https://s3.fr-par.scw.cloud, https://s3.eu-central-1.amazonaws.com',
    }),
    region: Flags.string({
      char: 'r',
      description: 'S3 region',
      default: 'auto',
    }),
    'access-key': Flags.string({
      description: 'S3 access key. Defaults to FLUI_S3_ACCESS_KEY env var.',
      env: 'FLUI_S3_ACCESS_KEY',
    }),
    'secret-key': Flags.string({
      description: 'S3 secret key. Defaults to FLUI_S3_SECRET_KEY env var.',
      env: 'FLUI_S3_SECRET_KEY',
    }),
    'no-wait': Flags.boolean({
      default: false,
      description:
        'Return once the backup is queued; follow it with `flui operation <id> --follow`.',
    }),
    'key-prefix': Flags.string({
      description:
        'Override the destination key prefix (default: flui/<cluster>/<app>/<timestamp>/)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupCreate);

    let destination: BackupDestinationInput | undefined;
    if (flags.bucket) {
      if (!flags.endpoint) {
        this.error('--endpoint is required when --bucket is set');
      }
      if (!flags['access-key'] || !flags['secret-key']) {
        this.error(
          'S3 credentials missing. Pass --access-key/--secret-key or set FLUI_S3_ACCESS_KEY/FLUI_S3_SECRET_KEY.',
        );
      }
      destination = {
        bucket: flags.bucket,
        endpoint: flags.endpoint,
        region: flags.region,
        accessKeyId: flags['access-key'],
        secretAccessKey: flags['secret-key'],
        keyPrefix: flags['key-prefix'],
      };
    }

    let target = 'auto-provisioned bucket';
    if (destination) target = `s3://${destination.bucket}`;
    else if (flags.destination) target = `destination ${flags.destination}`;
    const spinner = ora(`Backing up "${args.name}" to ${target}...`).start();
    let started: StartedBackup;
    let op: Awaited<ReturnType<CliAppService['followBackup']>>;
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      started = await service.createAppBackup(app.id, {
        volumeName: flags.volume,
        description: flags.description,
        destinationId: flags.destination,
        destination,
        allowInconsistent: flags['allow-inconsistent'],
        pause: flags.pause,
      });
      if (flags['no-wait']) {
        spinner.succeed(
          `Backup of ${started.volumeName} queued (operation ${started.operationId})`,
        );
        console.log(
          chalk.dim(
            `\n  Follow it with: flui operation ${started.operationId} --follow\n`,
          ),
        );
        return;
      }
      spinner.text = `Backing up ${started.volumeName} of "${args.name}" to ${target}...`;
      op = await service.followBackup(started.operationId);
    } catch (error: any) {
      spinner.fail('Backup failed');
      if (renderCopyRefusal(error, `flui app backup create ${args.name}`)) {
        this.exit(1);
      }
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    if (!op) {
      spinner.warn(
        `Still running after a day — follow it with: flui operation ${started.operationId} --follow`,
      );
      return;
    }
    if (op.status !== 'COMPLETED' || !op.metadata?.result) {
      spinner.fail('Backup failed');
      if (
        renderCopyRefusal(
          { details: op.metadata?.error },
          `flui app backup create ${args.name}`,
        )
      ) {
        this.exit(1);
      }
      console.log(
        chalk.red(`\n  Error: ${op.errorMessage ?? op.status.toLowerCase()}\n`),
      );
      this.exit(1);
    }
    this.printResult(spinner, op.metadata.result, args.name, !destination);
  }

  private printResult(
    spinner: ReturnType<typeof ora>,
    backup: BackupResponse,
    appName: string,
    autoProvisioned: boolean,
  ): void {
    if (backup.engine === 'kopia') {
      spinner.succeed(
        `Snapshot taken: ${backup.artifactId ?? backup.snapshotId ?? backup.exportId}`,
      );
      if (backup.warning) console.log(chalk.yellow(`\n  ! ${backup.warning}`));
      console.log('');
      console.log(`  ${chalk.bold('Volume:')}    ${backup.sourcePvcName}`);
      console.log(
        `  ${chalk.bold('Size:')}      ${backup.actualBytes === undefined ? 'unknown' : formatBytes(backup.actualBytes)}`,
      );
      console.log(
        `  ${chalk.bold('Added:')}     ${backup.uploadedBytes === undefined ? 'unknown' : formatBytes(backup.uploadedBytes)} (new data stored at the destination)`,
      );
      console.log(`  ${chalk.bold('Encrypted:')} yes`);
      console.log(`  ${chalk.bold('Kept:')}      until deleted`);
      console.log('');
      console.log(chalk.dim(`  See it with: flui app backup list ${appName}`));
      console.log('');
      return;
    }
    spinner.succeed(`Backup uploaded: ${backup.exportId}`);
    if (backup.warning) {
      console.log('');
      console.log(chalk.yellow(`  ! ${backup.warning}`));
    }
    console.log('');
    console.log(`  ${chalk.bold('Provider:')}  ${backup.provider}`);
    console.log(`  ${chalk.bold('Namespace:')} ${backup.namespace}`);
    console.log(`  ${chalk.bold('Source:')}    ${backup.sourcePvcName}`);
    console.log(`  ${chalk.bold('Source request:')}  ${backup.sizeGb} GiB`);
    const uploaded =
      backup.actualBytes === undefined
        ? 'unknown'
        : formatBytes(backup.actualBytes);
    console.log(`  ${chalk.bold('Uploaded:')}        ${uploaded}`);
    console.log(`  ${chalk.bold('Bucket:')}    ${backup.destination.bucket}`);
    console.log(`  ${chalk.bold('Endpoint:')}  ${backup.destination.endpoint}`);
    console.log(`  ${chalk.bold('Prefix:')}    ${backup.exportId}`);
    console.log(`  ${chalk.bold('Created:')}   ${backup.createdAt}`);
    console.log('');
    if (autoProvisioned) {
      console.log(
        chalk.dim(
          `  Bucket auto-provisioned by ${backup.provider} object storage.`,
        ),
      );
    }
    console.log('');
  }
}
