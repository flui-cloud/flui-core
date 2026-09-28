export const IN_CLUSTER_API_URL =
  'http://flui-api.flui-system.svc.cluster.local:3000';

export const IN_CLUSTER_RELAY_URL =
  'http://flui-authz.flui-system.svc.cluster.local';

export interface ForwardAuthPlacement {
  apiRunsOnThisCluster: boolean;
  relayRunsOnThisCluster: boolean;
  isControlCluster: boolean;
  publicApiUrl: string;
}

/** Where a cluster stands, seen from this API process. */
export function forwardAuthPlacement(
  isControlCluster: boolean,
  relayRunsOnThisCluster: boolean,
): ForwardAuthPlacement {
  return {
    apiRunsOnThisCluster:
      !!process.env.KUBERNETES_SERVICE_HOST && isControlCluster,
    relayRunsOnThisCluster,
    isControlCluster,
    publicApiUrl:
      process.env.PUBLIC_API_URL ||
      process.env.FLUI_API_ENDPOINT ||
      process.env.API_BASE_URL ||
      process.env.WEBHOOK_BASE_URL ||
      '',
  };
}

/**
 * Where Traefik asks whether a request to a protected host may pass. The
 * route id is always in the address. On another cluster the check goes to
 * the cluster's own relay, which reads the request's forwarded headers
 * untouched and asks the API in fields of its own: a check sent straight to
 * the public API would cross the control's proxy, which drops them. Without
 * a relay there is no address, and the route stays closed.
 */
export function gatewayForwardAuthAddress(
  endpointId: string,
  where: ForwardAuthPlacement,
): string | undefined {
  if (where.apiRunsOnThisCluster) {
    return `${IN_CLUSTER_API_URL}/api/v1/authz/gateway/${endpointId}`;
  }
  if (where.relayRunsOnThisCluster) {
    return `${IN_CLUSTER_RELAY_URL}/gateway/${endpointId}`;
  }
  if (!where.isControlCluster) return undefined;
  let base = where.publicApiUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base ? `${base}/api/v1/authz/gateway/${endpointId}` : undefined;
}
