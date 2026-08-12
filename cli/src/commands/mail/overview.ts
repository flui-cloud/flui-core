import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface Kpi {
  id: string;
  count: number;
  rate: number | null;
  delta: number | null;
  tone: 'neutral' | 'warn' | 'bad';
}

interface DomainSummary {
  domain: string;
  spf: string;
  dkim: string;
  dmarc: string;
  verified: boolean;
  sent: number;
}

interface SenderSummary {
  from: string;
  application: { applicationName: string } | null;
  sent: number;
  deliveredRate: number | null;
  lastError: string | null;
  status: string;
}

interface Overview {
  provider: string | null;
  window: { from: string; to: string; name: string };
  incident: { title: string; detail: string; since: string | null } | null;
  kpis: Kpi[];
  domains: DomainSummary[];
  senders: SenderSummary[];
  unregisteredDomains: string[];
}

const KPI_LABEL: Record<string, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Complaints',
};

const STATUS_COLOUR: Record<string, (s: string) => string> = {
  delivering: chalk.green,
  degraded: chalk.yellow,
  failing: chalk.red,
  silent: chalk.gray,
};

export default class MailOverview extends Command {
  static readonly description =
    'The state of sending: what is broken, what it costs, and since when';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --window 24h',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    window: Flags.string({
      description: 'How far back to look',
      options: ['24h', '7d', '14d', '30d'],
      default: '14d',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailOverview);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const spinner = ora('Reading delivery state...').start();
    let overview: Overview;
    try {
      overview = await new ApiClient({ baseUrl: apiUrl, apiKey }).get<Overview>(
        `/mail/overview?window=${encodeURIComponent(flags.window)}`,
      );
      spinner.stop();
    } catch (error) {
      spinner.fail('Could not read the mail overview');
      this.error((error as Error).message);
      return;
    }

    if (flags.json) {
      this.log(JSON.stringify(overview, null, 2));
      return;
    }

    this.render(overview);
  }

  private render(o: Overview): void {
    const subtitle = `${o.provider ?? 'no provider'} · last ${o.window.name}`;
    this.log('');
    this.log(`  ${chalk.bold('Mail overview')}  ${chalk.dim(subtitle)}`);

    this.incident(o);

    this.log('');
    this.log(`  ${o.kpis.map((k) => this.kpi(k)).join('   ')}`);

    this.domains(o);
    this.unregistered(o);
    this.senders(o);

    this.log('');
  }

  /** The one thing to say first, and it goes first. */
  private incident(o: Overview): void {
    if (!o.incident) return;
    this.log('');
    this.log(`  ${chalk.red('▲')} ${chalk.bold(o.incident.title)}`);
    this.log(`    ${chalk.dim(o.incident.detail)}`);
    if (o.incident.since)
      this.log(`    ${chalk.dim('since ' + o.incident.since)}`);
  }

  private domains(o: Overview): void {
    if (!o.domains.length) return;
    this.log('');
    this.log(`  ${chalk.bold('Domains')}`);
    for (const d of o.domains) {
      const verdict = d.verified
        ? chalk.green('verified')
        : chalk.yellow('unverified');
      const volume = chalk.dim(`${d.sent} sent`);
      this.log(
        `    ${d.domain.padEnd(28)} ${proof('SPF', d.spf)} ${proof('DKIM', d.dkim)} ` +
          `${proof('DMARC', d.dmarc)}  ${verdict}  ${volume}`,
      );
    }
  }

  private unregistered(o: Overview): void {
    if (!o.unregisteredDomains.length) return;
    this.log('');
    this.log(
      `  ${chalk.yellow('Sending from domains with no proofs on record:')} ` +
        o.unregisteredDomains.join(', '),
    );
  }

  private senders(o: Overview): void {
    if (!o.senders.length) return;
    this.log('');
    this.log(`  ${chalk.bold('Senders')}`);
    for (const s of o.senders) {
      const paint = STATUS_COLOUR[s.status] ?? chalk.white;
      const name = s.application?.applicationName ?? s.from;
      const rate =
        s.deliveredRate === null ? '—' : `${pct(s.deliveredRate)} delivered`;
      this.log(
        `    ${name.padEnd(28)} ${paint(s.status.padEnd(11))} ` +
          `${String(s.sent).padStart(6)} sent  ` +
          chalk.dim(rate),
      );
      // Verbatim: the receiving server's own words are the only text that says why.
      if (s.lastError) this.log(`      ${chalk.dim(s.lastError)}`);
    }
  }

  private kpi(k: Kpi): string {
    const paint = TONE_COLOUR[k.tone] ?? chalk.white;
    const value = k.rate === null ? String(k.count) : pct(k.rate);
    return `${chalk.dim(KPI_LABEL[k.id] ?? k.id)} ${paint(value)}${delta(k)}`;
  }
}

const TONE_COLOUR: Record<string, (s: string) => string> = {
  bad: chalk.red,
  warn: chalk.yellow,
};

function pct(rate: number): string {
  return `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;
}

/**
 * No delta rather than a fabricated one: a baseline window that held nothing
 * cannot be compared against, and printing `+100%` would invent a trend.
 */
function delta(k: Kpi): string {
  if (k.delta === null || k.delta === 0) return '';
  const sign = k.delta > 0 ? '+' : '';
  const shown =
    k.rate === null
      ? `${sign}${(k.delta * 100).toFixed(0)}%`
      : `${sign}${(k.delta * 100).toFixed(2)}pt`;
  return chalk.dim(` (${shown})`);
}

function proof(label: string, verdict: string): string {
  if (verdict === 'ok') return chalk.green(`${label} ✓`);
  // DMARC absent is amber, never red: it does not block a send, and a red mark
  // on something that is not broken teaches people to ignore red marks.
  const paint = label === 'DMARC' ? chalk.yellow : chalk.red;
  return paint(`${label} ${verdict === 'mismatch' ? '✕' : '!'}`);
}
