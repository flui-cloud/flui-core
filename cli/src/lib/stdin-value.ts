import { readFileSync } from 'node:fs';

/**
 * The value piped in for `--stdin`, captured at import time.
 *
 * It has to happen this early. oclif attaches to standard input while parsing,
 * and by the time a command's `run()` is reached the descriptor is drained — a
 * read there returns an empty string, which then surfaces as "missing value"
 * for a credential that was in fact supplied. Reading it here, before any of
 * that machinery loads, is what makes the flag work at all.
 *
 * Guarded on the flag being present in `argv`: a bare `readFileSync(0)` on an
 * interactive terminal blocks until the user sends EOF, which would hang every
 * other command in the CLI.
 */
const requested = process.argv.includes('--stdin');

const captured: string | null = requested ? read() : null;

function read(): string {
  try {
    return readFileSync(0, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function stdinRequested(): boolean {
  return requested;
}

export function stdinValue(): string {
  return captured ?? '';
}
