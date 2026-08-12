import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface Connection {
  id: string;
  provider: string;
  scope: string;
  label: string;
  sendingDomain: string | null;
  isActive: boolean;
  hasCredential: boolean;
  webhookRegistered: boolean;
  implicit: boolean;
  credentialNote?: string;
  webhookNote?: string;
}

export default class MailProviders extends Command {
  static readonly description =
    'Show which provider carries which kind of mail';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailProviders);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const connections = await new ApiClient({ baseUrl: apiUrl, apiKey }).get<
      Connection[]
    >('/mail/connections');

    if (flags.json) {
      this.log(JSON.stringify(connections, null, 2));
      return;
    }

    if (!connections.length) {
      this.log('');
      this.log(
        '  No provider is connected. Scaleway works with the compute key you already have:',
      );
      this.log(
        chalk.dim(
          '    flui mail connect scaleway-tem --domain mail.example.com\n',
        ),
      );
      return;
    }

    this.log('');
    for (const scope of ['transactional', 'bulk'] as const) {
      const active = connections.find((c) => c.scope === scope && c.isActive);
      this.log(`  ${chalk.bold(scope.padEnd(14))}${describe(active)}`);
      for (const line of detailsOf(active)) this.log(INDENT + line);

      // Configured and ready to be switched to. Hidden, they look like nothing
      // was ever set up — which is what sends someone to paste a key again.
      for (const standby of connections.filter(
        (c) => c.scope === scope && !c.isActive,
      )) {
        const from = standby.sendingDomain
          ? ` from ${standby.sendingDomain}`
          : '';
        this.log(
          INDENT + chalk.dim('standby  ') + standby.label + chalk.dim(from),
        );
        this.log(INDENT + chalk.dim(`         flui mail use ${standby.id}`));
      }
    }
    this.log('');
  }
}

const INDENT = ' '.repeat(16);

/** What is worth saying about the connection currently carrying a scope. */
function detailsOf(active: Connection | undefined): string[] {
  if (!active) return [];
  const lines: string[] = [];
  if (active.sendingDomain)
    lines.push(chalk.dim(`from ${active.sendingDomain}`));
  if (active.credentialNote) lines.push(chalk.dim(active.credentialNote));
  if (!active.webhookRegistered && active.provider !== 'scaleway-tem') {
    lines.push(chalk.yellow('no delivery outcomes are arriving'));
    // The reason, not just the absence: it was recorded at the attempt, and it
    // is the only thing that says whether this is ours to fix or theirs.
    if (active.webhookNote) lines.push(chalk.dim(active.webhookNote));
  }
  return lines;
}

function describe(connection: Connection | undefined): string {
  if (!connection) {
    // Not an error for bulk: most installs never send a mailing list, and the
    // transactional providers are forbidden by their own terms from carrying one.
    return chalk.dim('nothing connected');
  }
  // "already in use" rather than nothing: Scaleway sends on the compute key
  // whether or not anyone configured it here, and calling that unconfigured
  // would be a lie about a sender that is delivering right now.
  const suffix = connection.implicit ? chalk.dim(' — already in use') : '';
  const missing = connection.hasCredential ? '' : chalk.red(' — no credential');
  return `${connection.label}${suffix}${missing}`;
}
