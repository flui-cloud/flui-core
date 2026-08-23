import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { confirmPrompt } from '../../../lib/prompts';
import { AccessDelta, printAccessDelta } from '../../../lib/access-delta';

export default class IamGrantRemove extends Command {
  static readonly description =
    'Remove an access grant by id, after saying what its holder stops being able to reach.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 3f9a…',
    '<%= config.bin %> <%= command.id %> 3f9a… --yes',
    '<%= config.bin %> <%= command.id %> 3f9a… --dry-run',
  ];

  static readonly args = {
    id: Args.string({
      description: 'Grant id (from `flui iam grant list`)',
      required: true,
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Say what would be lost and remove nothing',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IamGrantRemove);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    // Asked before the question, never after it: a person who has already
    // pressed yes is being informed, not warned. The API does the arithmetic so
    // this reads the same sentence the access screen and an agent read.
    const preview = await this.preview(api, args.id);
    if (preview) {
      console.log('');
      printAccessDelta(preview);
    } else {
      console.log(
        chalk.yellow(
          '\n  Could not read what this grant reaches, so what its holder loses is not known.\n',
        ),
      );
    }

    if (flags['dry-run']) {
      console.log(chalk.dim('  Dry run — nothing was removed.\n'));
      return;
    }

    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Remove grant ${chalk.bold(args.id)}?`,
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora(`Removing grant ${args.id}…`).start();
    try {
      const removed = await api.delete<{ delta?: AccessDelta }>(
        `/iam/grants/${args.id}`,
      );
      spinner.succeed(`Removed grant ${args.id}`);
      // What actually happened, not what was predicted: between the preview and
      // the delete somebody else may have changed the same person's access.
      if (removed?.delta) {
        console.log('');
        printAccessDelta(removed.delta);
      }
    } catch (error: unknown) {
      spinner.fail('Failed to remove grant');
      if (error instanceof ApiError && error.statusCode === 403) {
        console.log(chalk.yellow('  Requires the iam:assign-role permission.'));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }
  }

  /**
   * The warning is a courtesy, so its absence must not stop the command: a
   * caller who may remove a grant but not read the preview still gets the
   * honest "not known" line rather than a crash.
   */
  private async preview(
    api: ApiClient,
    id: string,
  ): Promise<AccessDelta | null> {
    const spinner = ora('Checking what this takes away…').start();
    try {
      const delta = await api.get<AccessDelta>(
        `/iam/grants/${id}/revocation-preview`,
      );
      spinner.stop();
      return delta;
    } catch {
      spinner.stop();
      return null;
    }
  }
}
