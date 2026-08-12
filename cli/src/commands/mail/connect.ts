import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface ConnectResult {
  connection: {
    id: string;
    provider: string;
    scope: string;
    label: string;
    sendingDomain: string | null;
  };
  observability: {
    channel: string;
    reports: string[];
    partial?: string[];
    limitation?: string;
  };
  domain: {
    published: string[];
    outstanding: {
      name: string;
      kind: string;
      value: string;
      purpose: string;
    }[];
    canWrite: boolean;
    verified: boolean;
    error?: string;
  } | null;
  webhook: { registered: boolean; url?: string; reason?: string };
  activated: boolean;
  manualSteps: string[];
}

const PROVIDERS = ['scaleway-tem', 'brevo', 'zeptomail', 'smtp'];

/**
 * Written, tested, and never yet watched carrying a real message to a real
 * inbox. The dashboard withholds these; the CLI still connects them, because
 * this is the tool someone reaches for *to* prove one — refusing here would
 * leave no way to move a provider off this list. It says so once, out loud,
 * rather than presenting them as equal to the two that have been exercised.
 */
const UNPROVEN = new Set(['zeptomail', 'smtp']);

/**
 * Where each credential comes from.
 *
 * Printed *before* the request rather than left to the API's refusal: "brevo
 * needs a credential" is true and useless to someone who has never opened
 * Brevo. The navigation path is spelled out alongside the URL so it still
 * works after a console redesign.
 */
const CREDENTIAL_HELP: Record<
  string,
  { where: string; url: string; caveat?: string }
> = {
  brevo: {
    where: 'Settings → SMTP & API → API Keys → Generate a new API key',
    url: 'https://app.brevo.com/settings/keys/api',
    caveat:
      'Shown once, so copy it before closing. Leave the expiry unset unless you\n' +
      '  plan to rotate it — sending stops the day it lapses.',
  },
  zeptomail: {
    where: 'Agents → your agent → SMTP/API → API tab → Send Mail Token',
    url: 'https://www.zoho.com/zeptomail/help/agents.html',
    caveat:
      'The token belongs to an agent, not to the account — one from the wrong\n' +
      '  agent sends from the wrong domain. Pass --region too: the API host IS\n' +
      '  the data residency.',
  },
  smtp: {
    where: "Host, port and credentials from your relay's own setup page",
    url: 'https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html',
    caveat:
      'For AWS SES: the SMTP credentials are not your AWS access keys, and they\n' +
      '  are issued per region.',
  },
};

export default class MailConnect extends Command {
  static readonly description =
    'Connect a mail provider and set up everything that can be set up';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> brevo --scope bulk --domain news.example.com --secret xkeysib-...',
    '<%= config.bin %> <%= command.id %> scaleway-tem --domain mail.example.com',
    '<%= config.bin %> <%= command.id %> smtp --host smtp.example.com --port 587 --username postmaster --secret pw --allow-bulk',
  ];

  static readonly args = {
    provider: Args.string({
      description: `One of: ${PROVIDERS.join(', ')}`,
      required: true,
      options: PROVIDERS,
    }),
  };

  static readonly flags = {
    scope: Flags.string({
      default: 'transactional',
      options: ['transactional', 'bulk'],
      description:
        'What this sender carries. Never the same account for both — a suspension caused by ' +
        'a mailing list would stop password resets too.',
    }),
    domain: Flags.string({
      description:
        'Sending domain. Flui registers it and publishes the records.',
    }),
    secret: Flags.string({
      description:
        'API key or relay password. Not needed for Scaleway, which reuses the compute key.',
    }),
    label: Flags.string({ description: 'What you call it' }),
    region: Flags.string({
      description: 'ZeptoMail only, and required: the regional API host.',
    }),
    host: Flags.string({ description: 'SMTP relay host' }),
    port: Flags.integer({ description: 'SMTP relay port' }),
    username: Flags.string({ description: 'SMTP username' }),
    'allow-bulk': Flags.boolean({
      default: false,
      description:
        'SMTP only: declare that this relay permits one-to-many mail. Never deduced.',
    }),
    activate: Flags.boolean({
      default: false,
      description:
        'Start sending through this one straight away. Without it a provider is stored and ' +
        'only takes the scope if nothing else holds it — switch later with `flui mail use`.',
    }),
    'spf-include': Flags.string({
      description: 'SMTP only: the include from the relay setup page',
    }),
    'dkim-selector': Flags.string({
      description: 'SMTP only: verbatim from the relay',
    }),
    'dkim-value': Flags.string({
      description: 'SMTP only: verbatim from the relay',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MailConnect);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    for (const line of unprovenWarning(args.provider)) this.log(line);

    const help = CREDENTIAL_HELP[args.provider];
    if (help && !flags.secret) {
      for (const line of credentialHelp(args.provider, help)) this.log(line);
      return;
    }

    const spinner = ora('Connecting the provider...').start();
    let result: ConnectResult;
    try {
      result = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).post<ConnectResult>(
        '/mail/connections',
        connectBody(args.provider, flags),
      );
      spinner.stop();
    } catch (error) {
      spinner.fail('The provider could not be connected');
      this.error((error as Error).message);
      return;
    }

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2));
      return;
    }

    for (const line of report(result)) this.log(line);
  }
}

type ConnectFlags = Record<string, string | boolean | undefined>;

/** Only what was actually given: an absent flag is not a value of `undefined`. */
function connectBody(
  provider: string,
  flags: ConnectFlags,
): Record<string, unknown> {
  const config = pruned({
    region: flags.region,
    host: flags.host,
    port: flags.port,
    username: flags.username,
    allowsBulk: flags['allow-bulk'] ? true : undefined,
    spfInclude: flags['spf-include'],
    dkimSelector: flags['dkim-selector'],
    dkimValue: flags['dkim-value'],
  });

  return pruned({
    provider,
    scope: flags.scope,
    label: flags.label,
    sendingDomain: flags.domain,
    secret: flags.secret,
    activate: flags.activate ? true : undefined,
    config: Object.keys(config).length ? config : undefined,
  });
}

function pruned(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
}

/** Said before the attempt, not after: afterwards it reads as an excuse. */
function unprovenWarning(provider: string): string[] {
  if (!UNPROVEN.has(provider)) return [];
  return [
    '',
    chalk.yellow(`  ${provider} is implemented but unproven.`),
    chalk.yellow(
      '  No message has been sent through it end to end yet, which is why the',
    ),
    chalk.yellow(
      '  dashboard withholds it and this does not — proving one starts here.',
    ),
    chalk.dim(
      '  Send a test before anything depends on it: flui mail test --connection <id>',
    ),
    '',
  ];
}

function credentialHelp(
  provider: string,
  help: { where: string; url: string; caveat?: string },
): string[] {
  return [
    '',
    `  ${chalk.bold(provider)} needs a credential.`,
    `  ${help.where}`,
    `  ${chalk.cyan(help.url)}`,
    ...(help.caveat ? [`  ${chalk.dim(help.caveat)}`] : []),
    '',
    chalk.dim('  Then re-run with --secret <value>.\n'),
  ];
}

/**
 * What happened, in the order it matters.
 *
 * The first line is the one that is easy to get wrong: connecting a provider
 * and sending through it are two different outcomes, and reporting the first as
 * if it were the second would leave someone waiting for mail that is still
 * going out through the old sender.
 */
function report(result: ConnectResult): string[] {
  return ['', ...headline(result), ...setup(result), ...leftovers(result), ''];
}

function headline(result: ConnectResult): string[] {
  const { connection } = result;
  if (result.activated) {
    return [
      `  ${chalk.green('✓')} ${connection.label} now carries ${chalk.bold(connection.scope)} mail.`,
    ];
  }
  return [
    `  ${chalk.green('✓')} ${connection.label} is configured, and not sending.`,
    chalk.dim(`    Something else holds ${connection.scope}. Switch with:`),
    chalk.dim(`      flui mail use ${connection.id}`),
  ];
}

function setup(result: ConnectResult): string[] {
  const { domain, webhook } = result;
  const lines: string[] = [];

  if (domain) {
    lines.push(
      ...domain.published.map(
        (record) => `    ${chalk.dim('published')} ${record}`,
      ),
      domain.verified
        ? `    ${chalk.green('verified')} by the provider`
        : `    ${chalk.yellow('pending')}   the provider has not confirmed the domain yet`,
    );
  }

  lines.push(
    webhook.registered
      ? `    ${chalk.dim('webhook')}   delivery events arriving at ${webhook.url}`
      : `    ${chalk.dim('webhook')}   not registered`,
  );
  return lines;
}

function leftovers(result: ConnectResult): string[] {
  const lines: string[] = [];

  // What this provider will never be able to tell you, said once and up front —
  // not discovered later from a console that reads as empty.
  if (result.observability.limitation) {
    lines.push(
      '',
      `  ${chalk.yellow('note')} ${result.observability.limitation}`,
    );
  }

  if (result.manualSteps.length) {
    lines.push(
      '',
      `  ${chalk.bold('Left for you:')}`,
      ...result.manualSteps.map((step) => `    · ${step}`),
    );
  }

  const domain = result.domain;
  if (domain?.outstanding.length && !domain.canWrite) {
    lines.push('');
    for (const record of domain.outstanding) {
      lines.push(
        `    ${chalk.dim(record.kind)} ${record.name}`,
        `         ${record.value}`,
      );
    }
  }

  lines.push(
    chalk.dim(
      '  Re-run this command any time — it converges rather than duplicating.\n',
    ),
  );
  return lines;
}
