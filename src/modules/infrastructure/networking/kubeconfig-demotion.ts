/** The `server:` line of a kubeconfig: scheme, host, optional port. */
export const SERVER_LINE =
  /(\bserver:\s*https:\/\/)([^\s:/]+|\[[^\]]+\])(:\d+)?/;

/**
 * Set on a workload cluster when a person moved its API address back to the
 * public path. The promoter leaves such a cluster alone until the hold is
 * released, so an emergency demotion is not undone by the next sweep.
 */
export interface OverlayDemotion {
  at: string;
  by: string;
  from: string;
  to: string;
}

export function overlayDemotionOf(cluster: {
  metadata?: Record<string, unknown> | null;
}): OverlayDemotion | undefined {
  const hold = (cluster.metadata as { overlayDemotion?: OverlayDemotion })
    ?.overlayDemotion;
  return hold?.at ? hold : undefined;
}

export function serverHostOf(kubeconfig: string): string | undefined {
  return SERVER_LINE.exec(kubeconfig)?.[2];
}

export function withServerHost(kubeconfig: string, host: string): string {
  const spelled =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return kubeconfig.replace(SERVER_LINE, `$1${spelled}$3`);
}
