import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ManagementNetworkClient } from '../../../lib/management-network-client';
import { printManagementNetwork } from '../../../lib/management-network-view';

export default class EnvOverlayStatus extends Command {
  static readonly description =
    'Show the Flui network: whether it is on, why it cannot be, the control end and every member with its last handshake.';

  async run(): Promise<void> {
    try {
      printManagementNetwork(await ManagementNetworkClient.open().status());
    } catch (error: any) {
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
