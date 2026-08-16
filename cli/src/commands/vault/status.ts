import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { VaultFile } from '../../lib/vault/vault-file';
import { askAgent, socketIsSafe } from '../../lib/vault/vault-agent';
import {
  describeRemaining,
  isOpen,
  resolveLimits,
} from '../../lib/vault/vault-session';

export default class VaultStatus extends Command {
  static readonly description =
    'Show whether the vault exists, whether it is unlocked, and how long it has left.';

  static readonly flags = {
    format: Flags.string({ options: ['text', 'json'], default: 'text' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VaultStatus);
    const vault = new VaultFile();
    const limits = resolveLimits();

    if (!vault.exists()) {
      if (flags.format === 'json') {
        this.log(JSON.stringify({ initialised: false, unlocked: false }));
        return;
      }
      this.log(chalk.yellow('\n🔒 No vault on this machine.\n'));
      this.log(
        chalk.dim(
          '   Credentials stored today are sealed with a key kept beside them,\n' +
            '   which protects nothing from anyone who can read the directory.\n',
        ),
      );
      this.log(`   Create one with:  ${chalk.cyan('flui vault init')}\n`);
      return;
    }

    const response = await askAgent({ op: 'status' });
    const state = response?.ok ? response.state : undefined;
    const open = isOpen(state);

    if (flags.format === 'json') {
      this.log(
        JSON.stringify({
          initialised: true,
          unlocked: open,
          location: vault.location,
          idleRemainingMs: isOpen(state) ? state.idleRemainingMs : 0,
          lifeRemainingMs: isOpen(state) ? state.lifeRemainingMs : 0,
        }),
      );
      return;
    }

    this.log(
      open ? chalk.green('\n🔓 Unlocked\n') : chalk.yellow('\n🔒 Locked\n'),
    );
    this.log(`   ${chalk.dim('Vault:')}  ${vault.location}`);

    if (isOpen(state)) {
      this.log(
        `   ${chalk.dim('Idle:')}   closes in ${describeRemaining(state.idleRemainingMs)}`,
      );
      this.log(
        `   ${chalk.dim('Life:')}   closes in ${describeRemaining(state.lifeRemainingMs)} regardless`,
      );
      if (!socketIsSafe()) {
        // Worth interrupting for: the socket is the only thing keeping another
        // user on this machine away from the key.
        this.log(
          chalk.red(
            '\n   ⚠ The agent socket is reachable by other users on this machine.\n' +
              '     Lock the vault and check the permissions on ~/.flui.',
          ),
        );
      }
    } else {
      this.log(
        chalk.dim(
          `   Would stay open for ${describeRemaining(limits.idleMs)} of inactivity once unlocked.`,
        ),
      );
      this.log(`\n   Unlock with:  ${chalk.cyan('flui vault unlock')}`);
    }
    this.log('');
  }
}
