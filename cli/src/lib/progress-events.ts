import { writeSync } from 'node:fs';

/**
 * Structured progress for callers that are not a human reading a terminal.
 *
 * When `FLUI_EVENTS_FD` names an open file descriptor, every milestone is also
 * written there as one JSON object per line. It goes to its own descriptor
 * rather than stdout so the spinner, the colours and the streamed bootstrap log
 * stay exactly as they are for interactive use — a machine reader gets a clean
 * channel without anyone having to parse decorated output.
 *
 * Nothing here may carry a secret: these lines are forwarded verbatim by
 * whoever is reading them, including to a browser.
 */
export type ProgressEvent =
  | {
      type: 'phase';
      phase: string;
      state: 'started' | 'completed';
      percent?: number;
    }
  | { type: 'log'; line: string }
  | { type: 'resource'; kind: string; id: string | null; name: string }
  | { type: 'released'; name: string }
  | { type: 'ready'; endpoint: string }
  | { type: 'failed'; phase: string; message: string };

const fd = Number.parseInt(process.env.FLUI_EVENTS_FD ?? '', 10);
const enabled = Number.isInteger(fd) && fd > 2;

export function eventsEnabled(): boolean {
  return enabled;
}

export function emitEvent(event: ProgressEvent): void {
  if (!enabled) return;
  try {
    writeSync(
      fd,
      `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
    );
  } catch {
    // A closed reader must never take down a provisioning run that is already
    // holding paid cloud resources.
  }
}
