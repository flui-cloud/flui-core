import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { promptMaskedInput } from '../../../lib/prompts';
import { refuseToAsk } from '../../../lib/non-interactive';
import { stdinRequested, stdinValue } from '../../../lib/stdin-value';

/**
 * Deliver a sensitive variable.
 *
 * There is no `--value` flag, and adding one would undo the command. An
 * argument is written to the shell history of whoever ran it, is visible in
 * `ps` to every other process on the machine while it runs, and — when an agent
 * is the one composing the command — is copied into the model's context on the
 * way. So the value is asked for, or read from standard input, and never
 * appears in `argv`.
 *
 * It is not read back either. The command prints the key and whether it is now
 * configured; the value is not echoed, not logged, and not returned by the API.
 */
export default class AppEnvSet extends Command {
  static readonly description =
    'Deliver the value of a sensitive variable. The value is prompted for (or read from standard input) and never appears in the command, its output, or any log.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api STRIPE_SECRET_KEY',
    'pbpaste | <%= config.bin %> <%= command.id %> my-api STRIPE_SECRET_KEY --stdin',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    key: Args.string({
      description: 'Variable name (the NAME, never the value)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    stdin: Flags.boolean({
      description: 'Read the value from standard input rather than prompting.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppEnvSet);

    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(clusterId);
    const app = await service.getAppByName(args.app);

    const value =
      flags.stdin || stdinRequested()
        ? stdinValue()
        : await this.askForValue(args.key);

    if (!value) {
      // Not "the command failed": nothing was delivered, so nothing changed.
      // Saying so plainly beats writing an empty string over a real secret.
      this.error(
        `No value was supplied, so ${args.key} was left as it is.\n` +
          `Pass it on standard input instead:  printf '…' | flui app env set ${args.app} ${args.key} --stdin`,
        { exit: 1 },
      );
    }

    const after = await service.setSensitiveVariable(app.id, args.key, value);

    const configured = after.sensitiveKeys.includes(args.key);
    if (!configured) {
      this.error(
        `${args.key} was not stored. The API refused it — a key linked to a building block's secret, or the display mask sent as a value, is left untouched on purpose.`,
        { exit: 1 },
      );
    }

    this.log(chalk.green(`\n✅ ${args.key} is configured on "${app.name}"`));
    this.log(
      chalk.dim(
        '   The value is not shown here and cannot be read back — only whether it is set.',
      ),
    );
    if (after.pendingKeys.length) {
      this.log(
        chalk.yellow(
          `   Still awaiting a value: ${after.pendingKeys.join(', ')}`,
        ),
      );
    }
    this.log(
      chalk.dim(
        `\n   Redeploy for the application to receive it:  flui app redeploy ${app.name}\n`,
      ),
    );
  }

  private async askForValue(key: string): Promise<string> {
    refuseToAsk(
      `the value of ${key}`,
      `Pass it on standard input instead:  printf '…' | flui app env set <app> ${key} --stdin`,
    );
    return (await promptMaskedInput(`  Value for ${key}`)).trim();
  }
}
