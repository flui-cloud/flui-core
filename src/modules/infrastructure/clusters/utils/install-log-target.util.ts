/**
 * Where to reach a new node to read its install log. From outside the cluster
 * that is its public address, which the firewall opens to the operator. From
 * inside the control cluster — the API running on it — the public address of
 * a worker is closed to the master's own address (only the operator's are on
 * the SSH rule), while the private network reaches it directly.
 */
export function installLogTarget(facts: {
  publicIp: string | null | undefined;
  privateIp: string | null | undefined;
  controlCluster: boolean;
  apiInCluster: boolean;
}): string | null {
  if (facts.apiInCluster && facts.controlCluster && facts.privateIp) {
    return facts.privateIp;
  }
  return facts.publicIp ?? facts.privateIp ?? null;
}

/** Kubernetes puts this in every pod's environment; nothing else sets it. */
export function apiRunsInCluster(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env.KUBERNETES_SERVICE_HOST;
}
