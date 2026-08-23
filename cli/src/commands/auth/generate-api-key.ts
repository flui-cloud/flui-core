import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ConfigStorage } from '../../lib/config-storage';
import { ProfileManager } from '../../lib/profile-manager';

export default class AuthGenerateApiKey extends Command {
  static readonly description =
    'Generate a Flui M2M API key and save it to the active profile (OIDC mode only). ' +
    'Pass your Zitadel session token via --token or FLUI_SESSION_TOKEN.';

  // Three of these four used to omit the scope list, which is to say the
  // documented default was the widest credential the instance can issue. They
  // now say `--unscoped` out loud, because that is what they were asking for.
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --token <zitadel-jwt> --unscoped',
    '<%= config.bin %> <%= command.id %> --name ci-pipeline --expires 365 --unscoped',
    '<%= config.bin %> <%= command.id %> --name agent --scope mcp:app:read --scope mcp:obs:read',
    'FLUI_SESSION_TOKEN=<jwt> <%= config.bin %> <%= command.id %> --unscoped',
  ];

  static readonly flags = {
    token: Flags.string({
      description: 'Session Bearer token (or env FLUI_SESSION_TOKEN)',
    }),
    name: Flags.string({
      description: 'Human-readable name for the key',
      default: 'cli',
    }),
    expires: Flags.integer({
      description: 'Expiry in days from now (omit for no expiry)',
    }),
    scope: Flags.string({
      description:
        'Scope granted to the key (repeatable). A scope you do not hold ' +
        'yourself is refused, not trimmed.',
      multiple: true,
    }),
    unscoped: Flags.boolean({
      description:
        'Issue a key with no scope ceiling, carrying your full weight. Say it ' +
        'on purpose: it used to be what omitting --scope did quietly.',
      default: false,
      exclusive: ['scope'],
    }),
    profile: Flags.string({
      description: 'Profile to save the key into (default: active profile)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthGenerateApiKey);

    // Asked before anything else, because it is the only question here that can
    // be answered without a credential, a profile or a network. The API refuses
    // the same request identically; this is so nobody has to go and find a
    // session token to be told they had not said what the key is for.
    if (!flags.scope?.length && !flags.unscoped) {
      this.error(
        'Say what this key may do.\n' +
          '  --scope <mcp:...>   a limited key; repeat the flag for more than one\n' +
          '  --unscoped          a key carrying your full weight\n' +
          'Omitting both used to mean --unscoped, silently.',
        { exit: 2 },
      );
    }

    const sessionToken = flags.token ?? process.env.FLUI_SESSION_TOKEN;
    if (!sessionToken) {
      this.error(
        'A session Bearer token is required.\n' +
          'Pass it via --token <jwt> or set FLUI_SESSION_TOKEN.',
        { exit: 2 },
      );
    }

    const profile = flags.profile ?? ProfileManager.getActiveProfile();
    const storage = new ConfigStorage(profile);
    const baseUrl = storage.getApiUrlOrThrow();

    let expiresAt: string | undefined;
    if (flags.expires) {
      const d = new Date();
      d.setDate(d.getDate() + flags.expires);
      expiresAt = d.toISOString();
    }

    this.log(chalk.dim(`API URL: ${baseUrl}`));
    this.log(chalk.dim(`Profile: ${profile}`));

    let result: {
      id: string;
      name: string;
      key: string;
      expiresAt?: string;
      scopes?: string[] | null;
    };
    try {
      const res = await fetch(`${baseUrl}/auth/api-keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: flags.name,
          expiresAt,
          ...(flags.scope?.length
            ? { scopes: flags.scope }
            : { unscoped: true }),
        }),
      });

      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const msg =
          (body as { message?: string }).message ?? `HTTP ${res.status}`;
        this.error(`API error: ${msg}`, { exit: 1 });
      }
      result = body as typeof result;
    } catch (e) {
      this.error(`Request failed: ${(e as Error).message}`, { exit: 1 });
    }

    storage.setApiKey(result.key);

    this.log('');
    this.log(chalk.green('✔ API key generated and saved to profile'));
    this.log(`  ${chalk.bold('Profile:')}  ${profile}`);
    this.log(`  ${chalk.bold('Key ID:')}   ${result.id}`);
    this.log(`  ${chalk.bold('Name:')}     ${result.name}`);
    if (result.expiresAt) {
      this.log(`  ${chalk.bold('Expires:')}  ${result.expiresAt}`);
    }
    this.log(
      `  ${chalk.bold('Scopes:')}   ${
        result.scopes?.length
          ? result.scopes.join(' ')
          : chalk.dim('(unscoped — your full weight)')
      }`,
    );
    this.log('');
    this.log(
      chalk.yellow(
        '  ⚠  The plaintext key is not shown and cannot be retrieved again.',
      ),
    );
    this.log(
      chalk.dim(
        '  It is stored encrypted in ~/.flui/profiles/' +
          profile +
          '/config.json',
      ),
    );
    this.log('');
    this.log(
      chalk.dim(
        'Scripts will now pick it up automatically via ConfigStorage. ' +
          'You can also export it with: FLUI_API_KEY=$(flui config get apiKey)',
      ),
    );
  }
}
