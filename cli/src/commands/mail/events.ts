import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface DeliveryEvent {
  kind: string;
  provider: string;
  messageId: string;
  recipient: string;
  from?: string;
  at: string;
  reason?: string;
  code?: number;
  subject?: string;
}

const COLOUR: Record<string, (s: string) => string> = {
  delivered: chalk.green,
  sent: chalk.green,
  bounced: chalk.red,
  complained: chalk.red,
  deferred: chalk.yellow,
  queued: chalk.gray,
  canceled: chalk.gray,
  unsubscribed: chalk.yellow,
};

export default class MailEvents extends Command {
  static readonly description =
    'Delivery outcomes reported by the mail provider';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --since 2026-08-11T00:00:00Z',
    '<%= config.bin %> <%= command.id %> --message-id 4f2c…',
  ];

  static readonly flags = {
    since: Flags.string({ description: 'ISO timestamp. Exclusive.' }),
    'message-id': Flags.string({ description: 'Show only this message' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailEvents);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const spinner = ora('Polling the provider...').start();
    let events: DeliveryEvent[];
    try {
      const query = flags.since
        ? `?since=${encodeURIComponent(flags.since)}`
        : '';
      events = await new ApiClient({ baseUrl: apiUrl, apiKey }).get<
        DeliveryEvent[]
      >(`/mail/events${query}`);
      spinner.stop();
    } catch (error) {
      spinner.fail('Could not read delivery events');
      this.error((error as Error).message);
      return;
    }

    const shown = flags['message-id']
      ? events.filter((e) => e.messageId === flags['message-id'])
      : events;

    if (flags.json) {
      this.log(JSON.stringify(shown, null, 2));
      return;
    }

    if (!shown.length) {
      this.log(chalk.dim('\n  No delivery events in this window.\n'));
      return;
    }

    this.log('');
    for (const e of shown) {
      const paint = COLOUR[e.kind] ?? chalk.white;
      this.log(
        `  ${chalk.dim(e.at)}  ${paint(e.kind.padEnd(11))} ${e.recipient.padEnd(30)}` +
          chalk.dim(e.subject ?? ''),
      );
      // The receiving server's own words are the only text that says why, so
      // they are printed verbatim rather than paraphrased.
      if (e.reason) {
        const detail = `${e.code ?? ''} ${e.reason}`.trim();
        this.log(`      ${chalk.dim(detail)}`);
      }
    }
    this.log('');
  }
}
