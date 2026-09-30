import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export interface FluiProcess {
  pid: number;
  command: string;
}

const LAUNCHERS = /^(node\d*|nodejs|ts-node|sh|bash|zsh|dash)$/;

function isFluiScript(token: string): boolean {
  return (
    basename(token) === 'flui' ||
    /(^|\/)(flui[^/\s]*|cli)\/bin\/(run|dev)(\.js)?$/.test(token) ||
    token.endsWith('/background/cluster-worker.js')
  );
}

function isFluiCommand(command: string): boolean {
  const [exe = '', ...args] = command.trim().split(/\s+/);
  if (basename(exe) === 'flui') return true;
  return LAUNCHERS.test(basename(exe)) && args.some(isFluiScript);
}

function isVaultAgent(command: string): boolean {
  return /\svault\s+agent(\s|$)/.test(command);
}

const CREDENTIAL_WORD = /token|password|passphrase|secret|key/i;
const FLAG_VALUE = /^(=|\s+)(\S+)/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

function isCredentialFlag(word: string): boolean {
  const dash = word.indexOf('-');
  return dash >= 0 && CREDENTIAL_WORD.test(word.slice(dash));
}

/** Values of flags that look like credentials are not echoed back. */
export function redactCommand(command: string, max = 160): string {
  let redacted = '';
  let from = 0;
  for (const word of command.matchAll(/[\w-]+/g)) {
    if (word.index < from || !isCredentialFlag(word[0])) continue;
    const end = word.index + word[0].length;
    const value = FLAG_VALUE.exec(command.slice(end));
    if (!value) continue;
    redacted += `${command.slice(from, end)}${value[1]}***`;
    from = end + value[0].length;
  }
  redacted += command.slice(from);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function psEntry(line: string): FluiProcess | null {
  const rest = line.trimStart();
  const pid = /^\d+/.exec(rest)?.[0];
  if (!pid) return null;
  const tail = rest.slice(pid.length);
  const gap = tail.length - tail.trimStart().length;
  const commandFrom = Math.min(gap, tail.length - 1);
  if (commandFrom < 1 || LINE_BREAK.test(tail.slice(commandFrom))) return null;
  return { pid: Number(pid), command: tail.trim() };
}

export function parsePsOutput(output: string): FluiProcess[] {
  const out: FluiProcess[] = [];
  for (const line of output.split('\n')) {
    const entry = psEntry(line);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Other `flui` processes on this machine, the vault agent aside.
 *
 * A process started before an upgrade keeps running the old code. Before the
 * vault, that code created a new SSH CA whenever it found no plaintext one —
 * which is what it finds once the CA is sealed — and nodes then refuse the
 * operator. Listing them is the only warning such a process can be given.
 * Best effort: where `ps` is missing or fails, nothing is listed.
 */
export function otherFluiProcesses(
  opts: {
    ps?: () => string;
    exclude?: number[];
  } = {},
): FluiProcess[] {
  const exclude = new Set(opts.exclude ?? [process.pid, process.ppid]);
  let output = '';
  try {
    output = opts.ps
      ? opts.ps()
      : execFileSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'command='], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
  } catch {
    return [];
  }
  return parsePsOutput(output).filter(
    (p) =>
      !exclude.has(p.pid) &&
      isFluiCommand(p.command) &&
      !isVaultAgent(p.command),
  );
}
