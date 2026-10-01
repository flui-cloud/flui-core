import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import {
  VolumeBackupClient,
  resolveBackupId,
} from '../../../lib/volume-backup-client';
import { confirmPrompt } from '../../../lib/prompts';

interface RestoreContext {
  flags: {
    volume?: string;
    into?: string;
    yes?: boolean;
    swap?: boolean;
  };
  service: CliAppService;
  client: VolumeBackupClient;
  appId: string;
  backupId: string;
  target: { id: string; name: string };
}

export default class AppBackupRestore extends Command {
  static readonly description =
    'Restore a volume backup. Whole: into a new volume beside the application (or --to another one), which it uses once you --swap. ' +
    'With --path: the named files or directories are written back into the volume, over the current ones unless --into keeps them apart.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0',
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0 --swap',
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0 --to my-app-copy --swap',
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0 --path uploads/report.pdf --path config',
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0 --path uploads --into restored-uploads',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application the backup belongs to',
      required: true,
    }),
    backup: Args.string({
      description:
        'Backup id, or its first characters (from `flui app backup list`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    to: Flags.string({
      description:
        'Restore into this application instead (same cluster; use its id for another cluster)',
    }),
    volume: Flags.string({
      char: 'v',
      description:
        'Volume of the target application to restore for (default: the backed-up volume, or the only one)',
    }),
    swap: Flags.boolean({
      description:
        'Make the application use the restored volume right away (it restarts). The data it used before is kept as a separate volume.',
      exclusive: ['path'],
    }),
    path: Flags.string({
      char: 'p',
      multiple: true,
      description:
        'Restore only this path (file or directory, relative to the volume root). Repeatable. kopia backups only.',
    }),
    into: Flags.string({
      description:
        'With --path: write under this directory of the volume instead of over the current files',
      dependsOn: ['path'],
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Do not ask before writing over files in the live volume',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupRestore);
    const spinner = ora('Finding the backup...').start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const target = flags.to ? await this.targetOf(service, flags.to) : app;
      const client = VolumeBackupClient.create();
      const backup = resolveBackupId(await client.list(app.id), args.backup);
      if (!backup.restorable) {
        spinner.fail('This backup cannot be restored');
        console.log(chalk.red(`\n  ${backup.reason ?? 'Unknown reason'}\n`));
        this.exit(1);
      }
      spinner.stop();

      const ctx: RestoreContext = {
        flags,
        service,
        client,
        appId: app.id,
        backupId: backup.id,
        target,
      };
      if (flags.path?.length) {
        await this.restorePaths(ctx, flags.path);
        return;
      }
      await this.restoreWhole(ctx);
    } catch (error: any) {
      spinner.stop();
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }

  private async restorePaths(
    ctx: RestoreContext,
    paths: string[],
  ): Promise<void> {
    const { flags, client, appId, backupId, target } = ctx;
    if (!flags.into && !flags.yes) {
      const ok = await confirmPrompt(
        `Write ${paths.length} path(s) from backup ${backupId.slice(0, 8)} over the current files of ${target.name}?`,
      );
      if (!ok) {
        console.log(chalk.dim('  Aborted.'));
        return;
      }
    }
    const running = ora('Restoring files...').start();
    const res = await client.restoreFiles(appId, backupId, {
      paths,
      targetDirectory: flags.into,
      targetApplicationId: target.id === appId ? undefined : target.id,
      volumeName: flags.volume,
    });
    const under = res.targetDirectory ? ` under ${res.targetDirectory}/` : '';
    running.succeed(
      `Restored ${res.paths.length} path(s) into ${target.name}/${res.volumeName}${under}`,
    );
  }

  private async restoreWhole(ctx: RestoreContext): Promise<void> {
    const { flags, client, appId, backupId, target } = ctx;
    const running = ora(
      `Restoring backup ${backupId.slice(0, 8)} into a new volume...`,
    ).start();
    const res = await client.restore(appId, backupId, {
      targetApplicationId: target.id === appId ? undefined : target.id,
      volumeName: flags.volume,
    });
    running.succeed(`Restored into a new volume: ${res.newPvcName}`);
    const replaces = flags.volume ?? res.replaces;
    if (!flags.swap) {
      const volumeFlag = replaces ? ` --volume ${replaces}` : '';
      console.log('');
      console.log(chalk.dim('  Next step:'));
      console.log(
        chalk.dim(
          `  flui app snapshot swap ${target.name} ${res.newPvcName}${volumeFlag}`,
        ),
      );
      console.log('');
      return;
    }
    if (!replaces) {
      this.error(
        'The application has several volumes (or none); pass --volume to say which one the restored copy replaces.',
      );
    }
    await this.swap(ctx, replaces, res.newPvcName);
  }

  private async swap(
    ctx: RestoreContext,
    replaces: string,
    newPvcName: string,
  ): Promise<void> {
    const { service, target } = ctx;
    const swapping = ora(`Swapping ${replaces} for ${newPvcName}...`).start();
    try {
      await service.swapAppVolume(target.id, replaces, newPvcName);
    } catch (swapError) {
      swapping.fail('Swap failed');
      await service
        .deleteSpareVolume(target.id, newPvcName)
        .then(() =>
          console.log(
            chalk.dim(`  Removed the restored volume ${newPvcName}.`),
          ),
        )
        .catch(() =>
          console.log(
            chalk.yellow(
              `  The restored volume ${newPvcName} is still there: flui app snapshot discard ${target.name} ${newPvcName}`,
            ),
          ),
        );
      throw swapError;
    }
    swapping.succeed(
      'The application now uses the restored volume and is restarting',
    );
  }

  private async targetOf(
    service: CliAppService,
    ref: string,
  ): Promise<{ id: string; name: string }> {
    if (/^[0-9a-f-]{36}$/i.test(ref)) return { id: ref, name: ref };
    return service.getAppByName(ref);
  }
}
