import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface ReadinessStep {
  id: string;
  status: 'satisfied' | 'automatable' | 'manual' | 'pending';
  reason?: string;
  action?: string;
  consoleUrl?: string;
}

interface Readiness {
  provider: string;
  ready: boolean;
  projectId?: string | null;
  steps: ReadinessStep[];
}

const MARK: Record<ReadinessStep['status'], string> = {
  satisfied: chalk.green('✓'),
  automatable: chalk.cyan('→'),
  manual: chalk.yellow('!'),
  pending: chalk.gray('…'),
};

const MEANING: Record<ReadinessStep['status'], string> = {
  satisfied: 'done',
  automatable: 'Flui can do this',
  manual: 'needs you',
  pending: 'in progress at the provider',
};

export default class MailReadiness extends Command {
  static readonly description =
    'Report what still stands between Flui and a sent message';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --domain fluicloud.eu',
  ];

  static readonly flags = {
    domain: Flags.string({
      description:
        'Sending domain to inspect. Omitted, only the credential is checked.',
    }),
    json: Flags.boolean({
      description: 'Print the raw response',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailReadiness);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();

    if (!apiKey) {
      this.error('Not authenticated. Run `flui auth login` first.');
    }

    const spinner = ora('Asking the mail provider...').start();
    let readiness: Readiness;
    try {
      const query = flags.domain
        ? `?domain=${encodeURIComponent(flags.domain)}`
        : '';
      readiness = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).get<Readiness>(`/mail/readiness${query}`);
      spinner.stop();
    } catch (error) {
      spinner.fail('Could not read mail readiness');
      this.error((error as Error).message);
    }

    if (flags.json) {
      this.log(JSON.stringify(readiness, null, 2));
      return;
    }

    this.log('');
    this.log(
      `  ${chalk.bold('Mail readiness')}  ${chalk.dim(readiness.provider)}` +
        (flags.domain ? chalk.dim(`  ${flags.domain}`) : ''),
    );
    if (readiness.projectId) {
      // Surfaced because a domain registered under another project comes back
      // as "no domains" rather than as a mismatch.
      this.log(`  ${chalk.dim('project ' + readiness.projectId)}`);
    }
    this.log('');

    for (const step of readiness.steps) {
      this.log(
        `  ${MARK[step.status]} ${step.id.padEnd(14)}${chalk.dim(MEANING[step.status])}` +
          (step.reason ? chalk.dim(`  (${step.reason})`) : ''),
      );
      if (step.action) this.log(`      ${step.action}`);
      if (step.consoleUrl) this.log(`      ${chalk.dim(step.consoleUrl)}`);
    }

    this.log('');
    this.log(
      readiness.ready
        ? `  ${chalk.green('Ready to send.')}`
        : `  ${chalk.yellow('Not ready yet.')}`,
    );
    this.log('');
  }
}
