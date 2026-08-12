import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface RemoveResult {
  domain: string;
  revoked: boolean;
  dns: {
    removed: string[];
    kept: { name: string; kind: string; reason: string }[];
  } | null;
}

export default class MailRemove extends Command {
  static readonly description =
    'Hand a sending domain back to the mail provider';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> old.example.com --yes',
    '<%= config.bin %> <%= command.id %> old.example.com --keep-dns --yes',
  ];

  static readonly args = {
    domain: Args.string({
      description: 'Sending domain to remove',
      required: true,
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      default: false,
      description: 'Required. This cannot be undone, so it is not the default.',
    }),
    'keep-dns': Flags.boolean({
      default: false,
      description:
        'Revoke at the provider and leave the zone entirely untouched.',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MailRemove);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    if (!flags.yes) {
      // Scaleway's own words: deleting a domain is permanent and cannot be
      // undone. A flag is the confirmation a non-interactive tool can ask for.
      this.log('');
      this.log(
        `  ${chalk.bold(args.domain)} would be deleted at the mail provider.`,
      );
      this.log(
        '  This is permanent, and the DKIM private key is destroyed with it —',
      );
      this.log(
        '  registering the same domain again issues a new key under a new selector.',
      );
      this.log('');
      this.log(
        flags['keep-dns']
          ? '  The zone would be left untouched.'
          : '  In DNS: the DKIM record is deleted and the Flui include is taken back out of\n' +
              '  the SPF. The MX and DMARC are left alone — nothing recorded whether Flui\n' +
              '  created them, and deleting an MX it did not create stops inbound mail.',
      );
      this.log('');
      this.log(chalk.dim('  Re-run with --yes to go ahead.\n'));
      return;
    }

    const spinner = ora('Removing the domain...').start();
    let result: RemoveResult;
    try {
      const query = flags['keep-dns'] ? '?cleanupDns=false' : '';
      result = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).delete<RemoveResult>(
        `/mail/domains/${encodeURIComponent(args.domain)}${query}`,
      );
      spinner.stop();
    } catch (error) {
      spinner.fail('The domain could not be removed');
      this.error((error as Error).message);
      return;
    }

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2));
      return;
    }

    this.log('');
    this.log(
      result.revoked
        ? `  ${chalk.green('✓')} ${result.domain} was revoked at the provider.`
        : `  ${chalk.dim('·')} ${result.domain} was not registered at the provider.`,
    );

    if (result.dns?.removed.length) {
      this.log(`    ${chalk.dim('removed')} ${result.dns.removed.join(', ')}`);
    }
    for (const left of result.dns?.kept ?? []) {
      // Named individually rather than counted: leftovers with no explanation
      // are leftovers nobody acts on.
      this.log(`    ${chalk.yellow('kept')}    ${left.kind} ${left.name}`);
      this.log(`            ${chalk.dim(left.reason)}`);
    }
    this.log('');
  }
}
