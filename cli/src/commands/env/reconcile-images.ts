import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { printContextBanner } from '../../lib/context-banner';

interface PinnedImage {
  image: string;
  pinned: boolean;
  files: string[];
  reason?: string;
}

/**
 * The repair for a drift that has no visible symptom until it bites.
 *
 * An in-app update moves the running components and nothing else. The manifests
 * on the master, which k3s re-applies at every start, still name the old tags
 * and hand them back at the next reboot — measured on a live installation, a
 * `systemctl restart k3s` put a superseded build back with no error.
 */
export default class EnvReconcileImages extends Command {
  static readonly description =
    'Declare the component images that are actually running, so a reboot cannot hand back an older one. Changes nothing that is running.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvReconcileImages);
    printContextBanner();
    const spinner = ora('Comparing what runs with what is declared...').start();

    try {
      const { api } = await openControlPlane(await getNestApp());
      const result = await api.post<{ images: PinnedImage[] }>(
        '/platform/updates/reconcile-declared',
        {},
        // It runs a short job on the master and waits for it.
        { timeoutMs: 300_000 },
      );
      spinner.stop();

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2));
        return;
      }
      this.render(result.images);
    } catch (error) {
      spinner.fail('Could not reconcile the declared images');
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private render(images: PinnedImage[]): void {
    this.log('');
    if (images.length === 0) {
      this.log(
        chalk.dim('   No Flui components were found on the control cluster.\n'),
      );
      return;
    }

    for (const i of images) {
      const where = i.files.length ? chalk.dim(` (${i.files.join(', ')})`) : '';
      if (i.pinned) {
        this.log(`   ${chalk.green('✔')} ${i.image}${where}`);
      } else {
        this.log(`   ${chalk.yellow('⚠')} ${i.image}`);
        this.log(chalk.dim(`     ${i.reason ?? 'could not be declared'}`));
      }
    }

    const done = images.filter((i) => i.pinned).length;
    this.log('');
    this.log(
      done === images.length
        ? chalk.dim(
            '   What runs and what is declared now agree. A reboot will keep these.\n',
          )
        : chalk.yellow(
            '   Some components still declare a different image, and a reboot would hand it back.\n',
          ),
    );
  }
}
