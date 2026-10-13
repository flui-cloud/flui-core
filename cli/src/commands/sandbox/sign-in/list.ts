import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  SandboxClient,
  SignInProviderStatus,
} from '../../../lib/sandbox-client';
import { printContextBanner } from '../../../lib/context-banner';
import { callbackLines } from '../../../lib/sandbox-sign-in';

function stateOf(p: SignInProviderStatus): string {
  if (!p.connected) return chalk.dim('not connected');
  if (p.source === 'environment') {
    return chalk.yellow('connected from configuration variables');
  }
  if (p.source === 'identity-provider') {
    return chalk.yellow('connected, not managed by Flui');
  }
  return chalk.green(p.onSignInPage ? 'connected' : 'connected, not shown');
}

export default class SandboxSignInList extends Command {
  static readonly description =
    'GitHub and Google sign-in on a demo: which are connected, and the callback URL to register. Secrets are never shown.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SandboxSignInList);
    printContextBanner();

    const view = await SandboxClient.fromConfig().listSignInProviders();
    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }

    this.log('');
    if (!view.demo) {
      this.log(
        chalk.yellow(
          '   This installation is not a demo: GitHub and Google sign-in is only offered on one.\n',
        ),
      );
    }
    for (const p of view.providers) {
      this.log(`   ${chalk.bold(p.name.padEnd(8))} ${stateOf(p)}`);
      if (p.clientId)
        this.log(chalk.dim(`            client ID ${p.clientId}`));
      if (p.connectedBy) {
        this.log(
          chalk.dim(
            `            by ${p.connectedBy} at ${p.connectedAt ?? '?'}`,
          ),
        );
      }
      if (p.source === 'environment' || p.source === 'identity-provider') {
        this.log(
          chalk.dim(
            `            move it: flui sandbox sign-in connect ${p.provider}`,
          ),
        );
      }
    }
    const lines = callbackLines(null, view);
    if (lines.length) {
      this.log('');
      for (const [label, url] of lines) {
        this.log(`   ${label.padEnd(16)} ${url}`);
      }
      this.log(
        chalk.dim(
          '   If you change the sign-in address, update these at GitHub and Google.',
        ),
      );
    }
    this.log('');
  }
}
