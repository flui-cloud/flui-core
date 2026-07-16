import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  DeleteTarget,
} from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { confirmByTypingPrompt } from '../../lib/prompts';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 300_000; // 5 min

export default class AppDelete extends Command {
  static readonly description =
    'Delete an application and remove all its resources from the cluster. ' +
    'Works for both catalog installs and source-deploy (flui.yaml) apps. ' +
    'System-protected apps require --force.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> uptime-kuma',
    '<%= config.bin %> <%= command.id %> uptime-kuma --force',
    '<%= config.bin %> <%= command.id %> uptime-kuma --no-wait',
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
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after queuing the uninstall',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppDelete);
    const spinner = ora(`Looking up "${args.name}"…`).start();

    let service: CliAppService;
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      service = await CliAppService.create(clusterId);
    } catch (error: any) {
      spinner.fail('Setup failed');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }

    let target: Awaited<ReturnType<CliAppService['resolveDeleteTarget']>>;
    try {
      target = await service.resolveDeleteTarget(args.name);
    } catch (error: any) {
      spinner.fail('App not found');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }

    const isCatalog = target.kind === 'composed';
    let isSystemProtected = false;
    if (!isCatalog && target.appId) {
      const detail = await service.getAppDetail(target.appId);
      isSystemProtected = detail.systemProtected === true;
    }
    spinner.stop();

    if (isSystemProtected && !flags.force) {
      console.log(
        chalk.red(`\n  "${target.name}" is a system-protected application.\n`),
      );
      console.log(chalk.yellow('  Re-run with --force to delete it anyway.\n'));
      this.exit(1);
    }

    const proceed = await this.confirmDeletion(
      target,
      isCatalog,
      isSystemProtected,
      flags.force,
    );
    if (!proceed) return;

    const queueSpinner = ora(
      isCatalog ? 'Queuing uninstall…' : 'Queuing delete…',
    ).start();
    try {
      if (isCatalog) {
        await service.uninstall(target.catalogInstallId);
      } else {
        await service.deleteApp(target.appId);
      }
      queueSpinner.succeed(isCatalog ? 'Uninstall queued' : 'Delete queued');
      console.log('');
    } catch (error: any) {
      queueSpinner.fail(
        isCatalog ? 'Failed to queue uninstall' : 'Failed to queue delete',
      );
      const msg = error.response?.data?.message ?? error.message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    if (flags['no-wait'] || !isCatalog) {
      console.log(
        chalk.dim('  Use `flui app list` to verify the app is removed.\n'),
      );
      return;
    }

    await this.waitForUninstall(service, target.catalogInstallId, target.name);
  }

  private async confirmDeletion(
    target: DeleteTarget,
    isCatalog: boolean,
    isSystemProtected: boolean,
    force: boolean,
  ): Promise<boolean> {
    console.log(
      chalk.red(`\n  ${isCatalog ? 'UNINSTALL' : 'DELETE'} Application\n`),
    );
    console.log(`  ${chalk.bold('Name:')}   ${target.name}`);
    console.log(`  ${chalk.bold('Slug:')}   ${target.slug}`);
    console.log(
      `  ${chalk.bold('Kind:')}   ${isCatalog ? 'catalog' : 'source-deploy'}${isSystemProtected ? chalk.yellow(' (system-protected)') : ''}`,
    );
    console.log(`  ${chalk.bold('Status:')} ${target.status}`);
    console.log(
      chalk.red('\n  ALL DATA AND VOLUMES WILL BE PERMANENTLY DELETED!\n'),
    );

    if (force) return true;

    console.log(
      chalk.yellow(
        `  To confirm, type the app name exactly: ${chalk.bold(target.name)}`,
      ),
    );
    const confirmed = await confirmByTypingPrompt(
      chalk.yellow('  App name'),
      target.name,
    );
    if (!confirmed) {
      console.log(chalk.green('\n  Deletion cancelled (name did not match)\n'));
    }
    return confirmed;
  }

  private async waitForUninstall(
    service: CliAppService,
    catalogInstallId: string,
    appName: string,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `  Waiting for uninstall to complete (up to ${MAX_WAIT_MS / 60000} min)…`,
      ),
    );
    const waitSpinner = ora(`Uninstalling ${appName}…`).start();
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const done = await this.pollUninstall(
        service,
        catalogInstallId,
        appName,
        waitSpinner,
      );
      if (done) return;
    }

    waitSpinner.warn('Timed out waiting for uninstall');
    console.log(chalk.yellow(`\n  Uninstall is still running. Check with:`));
    console.log(chalk.dim(`    flui app list\n`));
  }

  private async pollUninstall(
    service: CliAppService,
    catalogInstallId: string,
    appName: string,
    waitSpinner: ReturnType<typeof ora>,
  ): Promise<boolean> {
    try {
      const current = await service.getInstallStatus(catalogInstallId);
      if (current.status === 'UNINSTALLED') {
        waitSpinner.succeed(
          chalk.green(`"${appName}" uninstalled successfully`),
        );
        console.log('');
        console.log(
          chalk.dim('  All resources and volumes have been removed.\n'),
        );
        return true;
      }
      if (current.status === 'FAILED') {
        waitSpinner.fail('Uninstall failed');
        const msg = current.errorMessage ?? 'Unknown error';
        console.log(chalk.red(`\n  Error: ${msg}\n`));
        this.exit(1);
      }
      waitSpinner.text = `Uninstalling ${appName}… (${current.status.toLowerCase()})`;
    } catch {
      /* polling error — keep trying */
    }
    return false;
  }
}
