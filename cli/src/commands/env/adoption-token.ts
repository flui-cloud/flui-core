import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { printContextBanner } from '../../lib/context-banner';

interface AdoptionTokenResponse {
  token: string;
  expiresAt: string;
  clusterId: string;
}

/**
 * Issues the one-time token that lets someone take ownership of this
 * installation from a machine that has never touched it.
 *
 * It exists for the handoff at the end of a managed provisioning run, where the
 * builder has to give the owner a way in and keep nothing themselves. It is
 * equally the recovery path for an operator who has the dashboard but has lost
 * the original token.
 */
export default class EnvAdoptionToken extends Command {
  static readonly description =
    'Issue a one-time token that lets someone adopt this installation with "flui env adopt".';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format json',
  ];

  static readonly flags = {
    format: Flags.string({
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvAdoptionToken);
    const json = flags.format === 'json';
    if (!json) printContextBanner();

    const configStorage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: configStorage.getApiUrl(),
      apiKey: configStorage.getApiKey(),
    });

    let issued: AdoptionTokenResponse;
    try {
      issued = await api.post<AdoptionTokenResponse>('/adoption/token', {});
    } catch (error) {
      this.error(
        `Could not issue an adoption token: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { exit: 1 },
      );
    }

    if (json) {
      // The only line on stdout, so a caller can parse it without stripping
      // anything: this output carries a live credential.
      this.log(JSON.stringify(issued));
      return;
    }

    this.log(chalk.cyan('\n🎟  Adoption token\n'));
    this.log(`   ${issued.token}\n`);
    this.log(
      chalk.dim(
        `   Valid until ${new Date(issued.expiresAt).toLocaleString()}`,
      ),
    );
    this.log(
      chalk.dim('   Single use. Anyone holding it can register a certificate'),
    );
    this.log(
      chalk.dim(
        '   authority on this installation, so treat it as a password.\n',
      ),
    );
    this.log(chalk.cyan("   Adopt from the owner's machine with:\n"));
    this.log(
      `   ${chalk.cyan(`flui env adopt ${issued.token.slice(0, 18)}…`)}\n`,
    );
  }
}
