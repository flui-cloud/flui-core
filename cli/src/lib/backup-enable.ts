import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient, BackupPolicy } from './backup-client';

/**
 * What every `flui backup enable` verb asks for, and nothing else.
 *
 * The flags that differ between the three are the point of splitting the
 * command up: `--engine-class` plus a `--scope` whose valid values depended on
 * it meant the tool accepted combinations it would then refuse, and the user
 * had to hold that matrix in their head to write a working command. Each verb
 * now takes only the flags that mean something for it, so an invalid
 * combination cannot be typed.
 */
export const SHARED_ENABLE_FLAGS = {
  destination: Flags.string({
    char: 'D',
    required: true,
    multiple: true,
    description:
      'Where the backups go: <destId>[:primary|replica[:priority]] (repeatable). ' +
      'See `flui backup destination list`.',
  }),
  name: Flags.string({
    description: 'Name for this protection. Defaults to something descriptive.',
  }),
  schedule: Flags.string({
    description:
      'Cron schedule in UTC, e.g. "0 2 * * *" for 02:00 daily. Omit it to ' +
      'use the default for this kind of backup.',
  }),
  'retention-days': Flags.integer({ min: 1, default: 30 }),
  'retention-max-copies': Flags.integer({ min: 1 }),
  enabled: Flags.boolean({ default: true, allowNo: true }),
};

export function parseDestinations(specs: string[]): Array<{
  destinationId: string;
  role: 'primary' | 'replica';
  priority?: number;
}> {
  return specs.map((spec) => {
    const [id, role = 'primary', prio] = spec.split(':');
    return {
      destinationId: id,
      role: role as 'primary' | 'replica',
      ...(prio ? { priority: Number.parseInt(prio, 10) } : {}),
    };
  });
}

/**
 * The profile is what the destinations already say, not a separate question.
 *
 * Asking for it as its own flag let it disagree with the destination list —
 * `--profile mirrored` with one destination, or the reverse — and neither the
 * CLI nor the API could tell which the user meant.
 */
export function profileFor(
  destinations: ReadonlyArray<{ role: 'primary' | 'replica' }>,
): 'single' | 'mirrored' {
  return destinations.some((d) => d.role === 'replica') ? 'mirrored' : 'single';
}

/**
 * The schedule the API recorded, in its own words. Never the flag echoed back:
 * the policy is what runs, and a policy saved without a schedule runs once.
 */
export async function recordedSchedule(
  client: BackupClient,
  policy: BackupPolicy,
): Promise<string> {
  const cron = policy.cronSchedule?.trim();
  if (!cron) return 'on demand only (no schedule; set one with --schedule)';
  try {
    const { schedule } = await client.getPolicyActivity(policy.id);
    const cronNote = `(${cron})`;
    return `${schedule.description} ${chalk.dim(cronNote)}`;
  } catch {
    return `cron ${cron} (UTC)`;
  }
}

export function printEnabled(
  policy: BackupPolicy,
  what: string,
  cadence?: string,
): void {
  console.log('');
  console.log(`  ${chalk.bold('Protecting:')}  ${what}`);
  console.log(`  ${chalk.bold('Runs:')}        ${cadence ?? 'continuously'}`);
  console.log(`  ${chalk.bold('Policy:')}      ${chalk.dim(policy.id)}`);
  console.log('');
  console.log(chalk.dim('   flui backup status     what is protected and how'));
  console.log(chalk.dim(`   flui backup policy delete ${policy.id}   stop`));
  console.log('');
}
