import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DemoClient } from '../../lib/demo-client';
import { printContextBanner } from '../../lib/context-banner';

export default class DemoStatus extends Command {
  static readonly description =
    'Show the cross-provider migration demo status and honest served/lost counters';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(DemoStatus);
    printContextBanner();
    const s = await DemoClient.fromConfig().status();
    if (flags.json) {
      this.log(JSON.stringify(s, null, 2));
      return;
    }
    const stateColor =
      s.state === 'failed'
        ? chalk.red
        : s.state === 'migrating'
          ? chalk.yellow
          : chalk.green;
    const lost = s.counters.lostDuringMigration;
    this.log('');
    this.log(
      `   demo: ${s.enabled ? chalk.green('enabled') : chalk.gray('disabled')}  state ${stateColor(s.state)}${s.windowOpen ? chalk.yellow('  [migration window open]') : ''}`,
    );
    this.log(
      `   on:   ${s.current.provider ?? '—'}  ${chalk.dim(s.current.ip ?? '')}  ${chalk.dim(s.current.clusterId ?? '')}`,
    );
    if (s.activeMigration) {
      this.log(
        `   migration ${chalk.cyan(s.activeMigration.id)}  ${s.activeMigration.status ?? '?'}`,
      );
    }
    this.log('');
    this.log(`   served ................. ${chalk.green(s.counters.served)}`);
    this.log(
      `   lost during migration .. ${lost === 0 ? chalk.green(0) : chalk.red(lost)}`,
    );
    this.log(
      `   success rate ........... ${s.counters.successRatePct ?? '—'}%`,
    );
    this.log(`   migrations completed ... ${s.cycleCount}`);
    if (s.lastCycleAt) {
      this.log(
        `   last migration ......... ${s.lastCycleDurationMs ? Math.round(s.lastCycleDurationMs / 1000) + 's' : '?'}  ${chalk.dim(s.lastCycleAt)}`,
      );
    }
    if (s.lastError) this.log(`   ${chalk.red('last error: ' + s.lastError)}`);
    this.log('');
  }
}
