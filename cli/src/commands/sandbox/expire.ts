import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SandboxClient } from '../../lib/sandbox-client';
import { confirmByTypingPrompt } from '../../lib/prompts';
import { printContextBanner } from '../../lib/context-banner';
import { colorState } from './list';

/**
 * Ends one guest area now, through the same teardown its deadline would have
 * run. The alternative — deleting the namespace on the machine — leaves the
 * identity-provider account behind, which is a defect this product has had once
 * already.
 */
export default class SandboxExpire extends Command {
  static readonly description = 'End one guest area now, through the reaper';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> user-guest-e182d08a',
    '<%= config.bin %> <%= command.id %> user-guest-e182d08a --force',
  ];
  static readonly args = {
    ref: Args.string({
      description: 'Namespace or id of the area',
      required: true,
    }),
  };
  static readonly flags = {
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip the confirmation',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxExpire);
    printContextBanner();

    const sandbox = SandboxClient.fromConfig();

    if (!flags.force) {
      this.log(
        chalk.yellow(
          `\n   Everything in ${chalk.bold(args.ref)} goes: the namespace and what runs in it, ` +
            `its applications, its grant and its identity-provider account.`,
        ),
      );
      const ok = await confirmByTypingPrompt(
        `   Type the area to confirm`,
        args.ref,
      );
      if (!ok) {
        this.log(chalk.dim('\n   Left alone.\n'));
        return;
      }
    }

    const result = await sandbox.expire(args.ref);

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2));
      return;
    }

    this.log('');
    this.log(`   ${chalk.bold(result.namespace)}  ${colorState(result.state)}`);
    if (result.lastError) {
      this.log(`   ${chalk.red('why')}  ${result.lastError}`);
    }
    this.log('');

    if (result.state !== 'expired') this.exit(1);
  }
}
