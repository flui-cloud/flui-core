/** A person's word that an application is not to be backed up. */
export interface AppBackupDecision {
  notBackedUp: true;
  note?: string;
  decidedBy: string;
  /** Who that was, as they were named when they decided. */
  decidedByName?: string;
  decidedAt: string;
}

export interface BackupDecisionInput {
  notBackedUp: boolean;
  note?: string | null;
}

export interface DecidingUser {
  userId: string;
  displayName?: string | null;
  name?: string | null;
  email?: string | null;
}

export const NOTE_MAX = 500;

export const NOT_BACKED_UP_CONSEQUENCE =
  'Flui stops asking for a backup of this application; nothing already taken is deleted.';

/** The decision to store, or null when the application is to be backed up again. */
export function backupDecisionFrom(
  input: BackupDecisionInput,
  user: DecidingUser,
  now: Date,
): AppBackupDecision | null {
  if (!input.notBackedUp) return null;
  const note = input.note?.trim().slice(0, NOTE_MAX);
  const name = (user.displayName || user.name || user.email || '').trim();
  return {
    notBackedUp: true,
    ...(note ? { note } : {}),
    decidedBy: user.userId,
    ...(name ? { decidedByName: name } : {}),
    decidedAt: now.toISOString(),
  };
}

export function notBackedUpByChoice(
  decision: AppBackupDecision | null | undefined,
): boolean {
  return decision?.notBackedUp === true;
}

/** What the request adds to the sentence a person approves. */
export function backupDecisionClause(body: unknown): string | undefined {
  const b = body as { notBackedUp?: unknown; note?: unknown } | null;
  if (b?.notBackedUp === false) return 'back it up again';
  const note = typeof b?.note === 'string' ? b.note.trim() : '';
  return note ? `note: ${note.slice(0, 120)}` : undefined;
}
