import chalk from 'chalk';
import {
  isSupportedArchitecture,
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
  return isSupportedArchitecture(raw) ? label : chalk.yellow(label);
}

/**
 * Why a host must not be installed on, from what `uname -m` printed there;
 * null when it is an x86 host.
 */
export function hostArchitectureRefusal(machine: string): string | null {
  const reported = machine.trim();
  if (isSupportedArchitecture(reported)) return null;
  const what = reported
    ? `This host is ${reported}`
    : 'The architecture of this host could not be read';
  return `${what}. Flui runs on x86 servers only for now, so nothing was installed.`;
}

/** Reads `uname -m` over SSH and refuses anything but an x86 host. */
export async function assertX86Host(
  run: (command: string) => Promise<string>,
): Promise<string> {
  const machine = (await run('uname -m')).trim();
  const refusal = hostArchitectureRefusal(machine);
  if (refusal) throw new Error(refusal);
  return machine;
}
