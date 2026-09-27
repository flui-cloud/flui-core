export const IN_CLUSTER_API_URL =
  'http://flui-api.flui-system.svc.cluster.local:3000';

export function gatewayForwardAuthAddress(
  endpointId: string,
  where: { apiRunsOnThisCluster: boolean; publicApiUrl: string },
): string | undefined {
  let base = where.apiRunsOnThisCluster
    ? IN_CLUSTER_API_URL
    : where.publicApiUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base ? `${base}/api/v1/authz/gateway/${endpointId}` : undefined;
}
