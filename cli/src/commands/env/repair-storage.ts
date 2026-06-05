import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { printContextBanner } from '../../lib/context-banner';

export default class EnvRepairStorage extends Command {
  static readonly description =
    'Backfill the shared-storage volume id into the cluster DB. Repairs clusters whose flui-secrets/DB never received FLUI_SHARED_STORAGE_VOLUME_ID at create — symptom is sharedStorageVolumeId NULL in the DB and "no Flui-managed shared storage volume" on storage expand. Reads the volume id from the active profile, patches flui-secrets over SSH, then restarts flui-api so the bootstrap seeder backfills the DB.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-restart',
  ];

  static readonly flags = {
    'no-restart': Flags.boolean({
      description:
        'Skip the flui-api rolling restart after patching the Secret',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvRepairStorage);
    printContextBanner();

    const app = await getNestApp();
    try {
      const control = app.get(CliControlClusterService);
      const ssh = app.get(CliSshService);
      const cluster = await control.getControlCluster();
      if (!cluster?.masterIpAddress) {
        this.log(chalk.red('  No control cluster found in this profile.'));
        this.exit(1);
        return;
      }

      const volumeId = cluster.sharedStorageVolumeId;
      const sizeGb = cluster.sharedStorageVolumeSizeGb;
      if (!volumeId) {
        this.log(
          chalk.red(
            '  No shared-storage volume id in this profile — nothing to backfill.',
          ),
        );
        this.exit(1);
        return;
      }

      const b64 = (s: string) => Buffer.from(s).toString('base64');
      const ops = [
        `{"op":"add","path":"/data/FLUI_SHARED_STORAGE_VOLUME_ID","value":"${b64(volumeId)}"}`,
      ];
      if (sizeGb) {
        ops.push(
          `{"op":"add","path":"/data/FLUI_SHARED_STORAGE_VOLUME_GB","value":"${b64(String(sizeGb))}"}`,
        );
      }

      const patchSpinner = ora(
        `Patching flui-secrets on ${cluster.masterIpAddress}...`,
      ).start();
      const patchCmd =
        `kubectl -n flui-system patch secret flui-secrets ` +
        `--type='json' -p='[${ops.join(',')}]'`;
      try {
        await ssh.sshExec(cluster.masterIpAddress, patchCmd);
        patchSpinner.succeed(
          `Secret patched (FLUI_SHARED_STORAGE_VOLUME_ID=${volumeId})`,
        );
      } catch (err: any) {
        patchSpinner.fail(`Patch failed: ${err.message}`);
        this.exit(1);
        return;
      }

      if (!flags['no-restart']) {
        const restartSpinner = ora('Restarting flui-api...').start();
        try {
          await ssh.sshExec(
            cluster.masterIpAddress,
            'kubectl -n flui-system rollout restart deployment/flui-api',
          );
          restartSpinner.succeed('flui-api rolling restart triggered');
        } catch (err: any) {
          restartSpinner.warn(
            `Restart failed (Secret was patched OK): ${err.message}`,
          );
        }
      }

      this.log('');
      this.log(
        chalk.green(
          '  ✅ Storage repair complete. On flui-api boot the seeder backfills sharedStorageVolumeId in the DB.',
        ),
      );
      this.log(
        chalk.dim(
          '     Verify with `flui env storage` or the storage-expand endpoint once flui-api is back up.\n',
        ),
      );
    } finally {
      await closeNestApp();
    }
  }
}
