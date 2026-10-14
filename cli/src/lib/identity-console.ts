export interface IdentityConsoleStatus {
  state: 'open' | 'closed';
  openUntil: string | null;
  openedAt: string | null;
  openedBy: string | null;
  reason: string | null;
  enforced: boolean;
  hosts: string[];
  redirectTo?: string | null;
  lastAppliedAt: string | null;
  lastError: string | null;
}

export const CONSOLE_MINUTES = { default: 60, min: 5, max: 240 };

function minutesLeft(until: string, now: Date): number {
  return Math.max(
    0,
    Math.ceil((new Date(until).getTime() - now.getTime()) / 60_000),
  );
}

export function identityConsoleLines(
  status: IdentityConsoleStatus,
  now = new Date(),
): string[] {
  const lines: string[] = [];
  if (status.state === 'open' && status.openUntil) {
    lines.push(
      `The identity provider console is OPEN until ${status.openUntil} (${minutesLeft(status.openUntil, now)} min left)`,
    );
    if (status.openedBy) lines.push(`Opened by: ${status.openedBy}`);
    if (status.reason) lines.push(`Reason: ${status.reason}`);
  } else {
    lines.push(
      'The identity provider console is closed. Sign-in is unaffected.',
      status.redirectTo
        ? `Visitors of the console are sent to ${status.redirectTo}`
        : 'Visitors of the console get 403 (no dashboard address is known)',
    );
  }
  if (status.hosts.length) lines.push(`Hosts: ${status.hosts.join(', ')}`);
  if (!status.enforced) {
    const why = status.lastError ? ': ' + status.lastError : '';
    lines.push(
      `Not applied to the cluster yet${why}. Flui retries every minute.`,
    );
  }
  return lines;
}

export const OPEN_CONSOLE_COMMAND =
  'flui identity console open --reason "<why>"';

/** How a credentials listing points at the identity provider console, which is closed by default. */
export function identityConsoleHint(domain: string): {
  state: 'closed-by-default';
  url: string;
  open: string;
  status: string;
} {
  return {
    state: 'closed-by-default',
    url: `https://${domain}/ui/console`,
    open: OPEN_CONSOLE_COMMAND,
    status: 'flui identity console',
  };
}

export function identityConsoleHintLine(): string {
  return `closed by default; open it for a limited time with \`${OPEN_CONSOLE_COMMAND}\``;
}
