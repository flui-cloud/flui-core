import { Command } from '@oclif/core';
import chalk from 'chalk';
import { askAgent } from '../../lib/vault/vault-agent';

export default class VaultLock extends Command {
  static readonly description =
    'Close the vault now, without waiting for it to time out.';

  async run(): Promise<void> {
    const response = await askAgent({ op: 'lock' });

    if (!response) {
      this.log(chalk.dim('\nAlready locked — no agent is holding a key.\n'));
      return;
    }
    this.log(
      chalk.green('\n🔒 Locked. The key has been overwritten in memory.\n'),
    );
  }
}
