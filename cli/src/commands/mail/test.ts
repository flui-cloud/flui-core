import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface TestMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

interface TestDraft {
  delivery: TestMessage;
  bounce: TestMessage;
}

interface TestResult {
  kind: 'delivery' | 'bounce';
  from: string;
  to: string;
  provider: string;
  messageId: string | null;
  accepted: number;
  alreadySuppressed?: boolean;
}

export default class MailTest extends Command {
  static readonly description =
    'Prove a domain can actually deliver, or that a hard bounce is caught';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> example.com',
    '<%= config.bin %> <%= command.id %> example.com --to me@elsewhere.test',
    '<%= config.bin %> <%= command.id %> example.com --bounce',
    '<%= config.bin %> <%= command.id %> --connection 7f3c1b0e-...',
  ];

  static readonly args = {
    domain: Args.string({
      description: 'Verified sending domain. Omit it when using --connection.',
    }),
  };

  static readonly flags = {
    connection: Flags.string({
      description:
        'Probe one provider instead of a domain, from `flui mail providers`. The only way to ' +
        'prove a bulk sender, or one configured and not yet sending.',
      exclusive: ['domain'],
    }),
    to: Flags.string({
      description:
        'Where to send it. Defaults to your own address — the one you can check.',
    }),
    bounce: Flags.boolean({
      default: false,
      description:
        'Send to a subdomain of this domain that deliberately does not exist, so a real refusal ' +
        'travels the whole path and you can watch it arrive.',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MailTest);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    if (!args.domain && !flags.connection) {
      this.error(
        'Name a sending domain, or pass --connection to probe one provider.',
      );
    }

    const kind = flags.bounce ? 'bounce' : 'delivery';
    const client = new ApiClient({ baseUrl: apiUrl, apiKey });
    const path = flags.connection
      ? `/mail/connections/${encodeURIComponent(flags.connection)}/test`
      : `/mail/domains/${encodeURIComponent(args.domain!)}/test`;

    // The address is printed before the message leaves, not after. Mail going
    // somewhere the operator never saw is the failure mode this avoids, and the
    // default recipient — their own account address — is exactly the one that
    // would otherwise be invisible.
    let draft: TestDraft;
    try {
      draft = await client.get<TestDraft>(path);
    } catch (error) {
      this.error((error as Error).message);
      return;
    }

    const message = kind === 'bounce' ? draft.bounce : draft.delivery;
    const to = flags.to?.trim() || message.to;
    if (!to) {
      this.error(
        'No recipient, and your account has no address to fall back to. Pass --to.',
      );
    }

    this.log('');
    this.log(`  ${chalk.dim('from')}    ${message.from}`);
    this.log(`  ${chalk.dim('to')}      ${chalk.bold(to)}`);
    this.log(`  ${chalk.dim('subject')} ${message.subject}`);
    this.log('');

    const spinner = ora(
      kind === 'bounce'
        ? 'Sending the bounce probe...'
        : 'Sending the test message...',
    ).start();

    let result: TestResult;
    try {
      result = await client.post<TestResult>(path, {
        kind,
        ...(kind === 'delivery' ? { to } : {}),
      });
      spinner.stop();
    } catch (error) {
      spinner.fail('The test could not be sent');
      this.error((error as Error).message);
      return;
    }

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2));
      return;
    }

    this.log('');
    if (result.alreadySuppressed) {
      // Not a failure. Refusing before sending is exactly what the probe set out
      // to demonstrate on its first run.
      this.log(
        `  ${chalk.green('✓')} ${chalk.bold('Nothing was sent — and that is the result.')}`,
      );
      this.log(
        `    ${result.to} is already on the do-not-send list from an earlier probe,`,
      );
      this.log('    so Flui refused before dialling. The bounce path works.');
      this.log(
        chalk.dim(`\n    Clear it with: flui mail unsuppress ${result.to}\n`),
      );
      return;
    }

    this.log(`  ${chalk.green('✓')} Accepted by ${result.provider}`);
    this.log(`    ${chalk.dim('from')} ${result.from}`);
    this.log(`    ${chalk.dim('to')}   ${result.to}`);
    if (result.messageId)
      this.log(`    ${chalk.dim('id')}   ${result.messageId}`);
    this.log('');
    // Acceptance is not delivery, and saying otherwise is the whole mistake
    // this feature exists to correct.
    this.log(
      kind === 'bounce'
        ? chalk.dim(
            '  Accepted, not delivered — it cannot be. Watch the refusal arrive:',
          )
        : chalk.dim(
            '  Accepted, not delivered. The receiver answers in seconds to minutes:',
          ),
    );
    this.log(chalk.dim('    flui mail events\n'));
  }
}
