import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface SendResult {
  provider: string;
  messageId: string | null;
  accepted: number;
}

export default class MailSend extends Command {
  static readonly description =
    'Send a message through the configured mail provider';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --from noreply@example.com --to someone@example.net --subject Hello --text "Hi there"',
  ];

  static readonly flags = {
    from: Flags.string({
      required: true,
      description:
        'Sender address. Must be on a domain the provider has verified.',
    }),
    to: Flags.string({
      required: true,
      multiple: true,
      description: 'Recipient address',
    }),
    subject: Flags.string({ required: true }),
    text: Flags.string({ description: 'Plain-text body' }),
    html: Flags.string({ description: 'HTML body' }),
    scope: Flags.string({
      options: ['transactional', 'bulk'],
      default: 'transactional',
      description:
        'One-to-one triggered by a user action, or one-to-many. A provider whose terms forbid ' +
        'the stated scope refuses the message rather than suspending the account later.',
    }),
    reference: Flags.string({ description: 'Your own correlation id' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailSend);

    if (!flags.text && !flags.html) {
      this.error('A message needs --text or --html.');
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const spinner = ora('Handing the message to the provider...').start();
    try {
      const result = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).post<SendResult>('/mail/send', {
        from: { email: flags.from },
        to: flags.to.map((email) => ({ email })),
        subject: flags.subject,
        ...(flags.text ? { text: flags.text } : {}),
        ...(flags.html ? { html: flags.html } : {}),
        scope: flags.scope,
        ...(flags.reference ? { reference: flags.reference } : {}),
      });
      spinner.succeed(`Accepted by ${result.provider}`);

      this.log('');
      this.log(
        `  messageId  ${result.messageId ?? chalk.dim('none returned')}`,
      );
      this.log(`  accepted   ${result.accepted}`);
      this.log('');
      // Accepted is not delivered. Saying so here is the difference between a
      // useful log and one that reports success for a message nobody received.
      this.log(
        chalk.dim(
          '  Accepted means the provider took it, not that it arrived.',
        ),
      );
      this.log(chalk.dim('  Run `flui mail events` for the verdict.'));
      this.log('');
    } catch (error) {
      spinner.fail('The provider refused the message');
      this.error((error as Error).message);
    }
  }
}
