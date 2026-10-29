export const CNPG_INSTANCE_ROLE_LABEL = 'cnpg.io/instanceRole';

interface PodLike {
  metadata?: { labels?: Record<string, string> };
  status?: { phase?: string };
}

/**
 * The running pod a command, a tunnel or a probe should reach. For a highly
 * available Postgres that is the primary, since a copy refuses writes and
 * reports a different disk; everything else keeps the first running pod.
 */
export function runningPodForDatabase<T extends PodLike>(
  pods: T[],
): T | undefined {
  const running = pods.filter((p) => p.status?.phase === 'Running');
  return (
    running.find(
      (p) => p.metadata?.labels?.[CNPG_INSTANCE_ROLE_LABEL] === 'primary',
    ) ?? running[0]
  );
}
