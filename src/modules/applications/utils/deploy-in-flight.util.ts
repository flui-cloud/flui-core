/** A deploy job runs at most twice for five minutes; past that, nothing carries the operation any more. */
const DEPLOY_ORPHANED_AFTER_MS = 15 * 60 * 1000;

/**
 * Whether an in-flight deploy is still being carried. One left IN_PROGRESS by a
 * job that died with its process would otherwise be handed back to every later
 * deploy of the same image, and none of them would ever reach the queue.
 */
export function stillCarried(
  op: { createdAt: Date; updatedAt?: Date | null },
  now: Date,
): boolean {
  const last = (op.updatedAt ?? op.createdAt).getTime();
  return now.getTime() - last < DEPLOY_ORPHANED_AFTER_MS;
}
