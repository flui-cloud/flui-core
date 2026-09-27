import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ManagementNetworkClient } from '../../../lib/management-network-client';
import { printManagementNetwork } from '../../../lib/management-network-view';

export default class EnvOverlayEnable extends Command {
  static readonly description =
    'Switch the Flui network on for this installation. Refused, with the reason, where it cannot work (for example a control with no reachable address). Stored on the installation, so an installer refresh does not change it.';

  async run(): Promise<void> {
    try {
      printManagementNetwork(await ManagementNetworkClient.open().set(true));
    } catch (error: any) {
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
