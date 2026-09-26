/**
 * An application operation still recorded as running while no job in the
 * queue carries it: the API restarted under it, or the job was dropped. Left
 * alone it keeps its application `updating` for ever, and it keeps the next
 * deploy waiting behind something that will never finish.
 */

export const LOST_AFTER_MS = 2 * 60 * 1000;

export const LOST_OPERATION_MESSAGE =
  'Nothing was running this any more: the job behind it was lost, usually because the API restarted. Deploy again to retry.';

export interface OperationRow {
  id: string;
  createdAt: Date;
  updatedAt?: Date | null;
}

export function lostOperations(
  inFlight: OperationRow[],
  liveOperationIds: Set<string>,
  now: Date,
  graceMs = LOST_AFTER_MS,
): OperationRow[] {
  return inFlight.filter((op) => {
    if (liveOperationIds.has(op.id)) return false;
    const touched = (op.updatedAt ?? op.createdAt).getTime();
    return now.getTime() - touched >= graceMs;
  });
}
