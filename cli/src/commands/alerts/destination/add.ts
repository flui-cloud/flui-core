import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  CreatedAlertDestination,
  DESTINATIONS_PATH,
  alertsApi,
  destinationBody,
} from '../../../lib/alert-destinations';

export default class AlertsDestinationAdd extends Command {
  static readonly description =
    'Send this installation’s alerts to an email address or a signed webhook';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --email oncall@example.com',
    '<%= config.bin %> <%= command.id %> --webhook https://hooks.example.com/flui --min-severity warning',
    '<%= config.bin %> <%= command.id %> --email oncall@example.com --scope all',
  ];

  static readonly flags = {
    email: Flags.string({ description: 'Email address to send alerts to' }),
    webhook: Flags.string({
      description:
        'Public https address that receives a signed JSON POST for every alert',
    }),
    'min-severity': Flags.string({
      description: 'The least severe alert this destination receives',
      options: ['warning', 'critical'],
      default: 'critical',
    }),
    scope: Flags.string({
      description:
        'What it hears: infrastructure (alerts no application owns: nodes, disks, certificates, platform backups) or all (every application’s alerts too; needs data access)',
      options: ['infrastructure', 'all'],
      default: 'infrastructure',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AlertsDestinationAdd);
    let body: ReturnType<typeof destinationBody>;
    try {
      body = destinationBody(flags);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 2 });
    }

    let created: CreatedAlertDestination;
    try {
      created = await alertsApi().post<CreatedAlertDestination>(
        DESTINATIONS_PATH,
        body,
      );
    } catch (error: unknown) {
      this.error(`Could not add the destination: ${(error as Error).message}`);
    }

    if (flags.output === 'json') {
      this.log(JSON.stringify(created, null, 2));
      return;
    }

    this.log('');
    this.log(
      `  ${chalk.green('✓')} ${created.kind} ${created.target} receives ${created.minSeverity === 'warning' ? 'warnings and critical alerts' : 'critical alerts'} ${created.scope === 'all' ? 'about everything, applications included' : 'about the infrastructure'}.`,
    );
    this.log(chalk.dim(`    id ${created.id}`));
    if (created.secret) {
      this.log('');
      this.log(`  Signing secret: ${chalk.bold(created.secret)}`);
      this.log(
        chalk.yellow(
          '  Store it now: it is shown this once and cannot be read back.',
        ),
      );
      this.log(
        chalk.dim(
          '  Verify each delivery: X-Flui-Signature is sha256=<hex HMAC-SHA256 of "<X-Flui-Timestamp>.<raw body>">,\n' +
            '  compared in constant time; refuse a timestamp more than 300 s from now, and a repeated X-Flui-Delivery id.',
        ),
      );
    }
    this.log(
      chalk.dim(
        `\n  Check it with: flui alerts destination test ${created.id}\n`,
      ),
    );
  }
}
