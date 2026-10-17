import chalk from 'chalk';
import {
  ARM_SERVER_WARNING,
  normaliseArchitecture,
} from 'src/modules/providers/core/catalogue/server-architecture';

/** `x86`, `arm`, or `-` where nothing says. */
export function archLabel(raw: string | null | undefined): string {
  return normaliseArchitecture(raw) ?? '-';
}

/** The ARCH cell, padded before colouring so escape codes do not count. */
export function archCell(
  raw: string | null | undefined,
  width: number,
): string {
  const label = archLabel(raw).padEnd(width);
  if (label.trim() === '-') return chalk.dim(label);
  return normaliseArchitecture(raw) === 'arm' ? chalk.yellow(label) : label;
}

/** The yellow line printed wherever an arm server is chosen. */
export function armWarningLine(): string {
  return chalk.yellow(`⚠  ${ARM_SERVER_WARNING}`);
}

/**
 * What to say about a host before installing on it, from what `uname -m`
 * printed there; null for an x86 host. Never a refusal.
 */
export function hostArchitectureWarning(machine: string): string | null {
  const reported = machine.trim();
  const architecture = normaliseArchitecture(reported);
  if (architecture === 'x86') return null;
  if (architecture === 'arm') return ARM_SERVER_WARNING;
  return reported
    ? `This host reports ${reported}, an architecture Flui does not know; continuing.`
    : 'The architecture of this host could not be read; continuing.';
}

/** Reads `uname -m` over SSH and prints a warning for anything but x86. */
export async function warnAboutHostArchitecture(
  run: (command: string) => Promise<string>,
  print: (line: string) => void = console.log,
): Promise<void> {
  let machine = '';
  try {
    machine = (await run('uname -m')).trim();
  } catch {
    machine = '';
  }
  const warning = hostArchitectureWarning(machine);
  if (warning) print(chalk.yellow(`\n⚠  ${warning}\n`));
}

/** What a deploy said that never blocked it, one yellow line each. */
export function deployWarningLines(warnings: string[] | undefined): string[] {
  return (warnings ?? []).map((warning) => chalk.yellow(`  ⚠  ${warning}`));
}
