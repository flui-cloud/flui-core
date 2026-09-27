import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ManagementNetworkClient } from '../../../lib/management-network-client';
import { printManagementNetwork } from '../../../lib/management-network-view';

export default class EnvOverlayDisable extends Command {
  static readonly description =
    'Switch the Flui network off for this installation. Nothing is torn down, but no new cluster joins it and clusters on another provider than the control cannot be created.';

  async run(): Promise<void> {
    try {
      printManagementNetwork(await ManagementNetworkClient.open().set(false));
    } catch (error: any) {
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
