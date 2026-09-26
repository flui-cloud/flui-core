import { ApplicationStatus } from '../enums/application-status.enum';

export const AVAILABILITY_KEYS = [
  'monitoring',
  'logs',
  'snapshots',
  'restart',
  'rollback',
] as const;
export type AvailabilityKey = (typeof AVAILABILITY_KEYS)[number];

export type AvailabilityState = 'available' | 'disabled' | 'hidden';

export interface AvailabilityEntry {
  key: AvailabilityKey;
  state: AvailabilityState;
  reason: string | null;
}

const NEVER_STARTED: ReadonlySet<ApplicationStatus> = new Set([
  ApplicationStatus.PENDING,
  ApplicationStatus.AWAITING_BUILD,
  ApplicationStatus.PROVISIONING,
  ApplicationStatus.WAITING_FOR_ROOM,
]);

function notStartedBecause(status: ApplicationStatus): string {
  return status === ApplicationStatus.WAITING_FOR_ROOM
    ? 'It waits for a node with room and has not started yet'
    : 'It has not started yet';
}

/**
 * Which tabs and actions make sense for an application in the state it is in.
 * One rule, read by the dashboard to switch tabs and buttons, and by the
 * routes that act, which refuse with the same reason.
 */
export function applicationAvailability(input: {
  status: ApplicationStatus;
  previousGoodRelease: boolean;
}): AvailabilityEntry[] {
  const { status } = input;
  const neverStarted = NEVER_STARTED.has(status);
  const off = (key: AvailabilityKey, reason: string): AvailabilityEntry => ({
    key,
    state: 'disabled',
    reason,
  });
  const on = (key: AvailabilityKey): AvailabilityEntry => ({
    key,
    state: 'available',
    reason: null,
  });
  const why = notStartedBecause(status);
  const restartRefusal = neverStarted
    ? `${why}: nothing is running to restart.`
    : 'It is stopped: start it instead of restarting it.';

  return [
    neverStarted
      ? off('monitoring', `${why}: there is nothing to measure.`)
      : on('monitoring'),
    neverStarted
      ? off('logs', `${why}: nothing has run, so there are no logs.`)
      : on('logs'),
    neverStarted
      ? off('snapshots', `${why}: it has written no data to back up.`)
      : on('snapshots'),
    neverStarted || status === ApplicationStatus.STOPPED
      ? off('restart', restartRefusal)
      : on('restart'),
    input.previousGoodRelease
      ? on('rollback')
      : {
          key: 'rollback',
          state: 'hidden',
          reason:
            'There is no earlier release that ran, so there is nothing to go back to.',
        },
  ];
}

export function refusalOf(
  entries: AvailabilityEntry[],
  key: AvailabilityKey,
): string | null {
  const entry = entries.find((e) => e.key === key);
  return entry && entry.state !== 'available' ? entry.reason : null;
}
