/**
 * The network fence around one tenancy.
 *
 * Calibrated rather than sealed: an application that cannot reach the internet
 * demonstrates less — no package installs, no webhooks, no API calls — and the
 * demo exists to show that real software runs here. So egress stays open to the
 * internet and is closed only where it would reach *us*: the cluster's own
 * private ranges, its metadata service, and the other tenancies.
 *
 * Ingress is the opposite: nothing may enter a tenancy except the ingress
 * controller. One guest must not be able to reach another guest's database by
 * its in-cluster address, which is the shortest path from "shared instance" to
 * "your data was readable by a stranger".
 */

/**
 * The ingress controller, allowed in by address because it cannot be selected.
 *
 * Traefik runs `hostNetwork: true` to bind :80/:443 on the node, and kube-router
 * never treats a host-networked pod as a policy peer — so no selector can match
 * it. Its packets source from the node's `flannel.1`/`cni0`, inside the pod
 * CIDR: k3s gives each node a `/24` of `10.42.0.0/16` and the CNI takes `.0`
 * and `.1`, handing pods `.2` upwards. Two addresses per node, never a pod's.
 *
 * Opening the whole `/16` instead was measured letting one tenancy reach
 * another's service, which is the sentence this fence exists to prevent.
 */
export const SANDBOX_INGRESS_SOURCE_CIDRS = Array.from(
  { length: 256 },
  (_, n) => `10.42.${n}.0/31`,
);

export function buildSandboxNetworkPolicy(
  namespace: string,
  options: { ingressNamespace?: string; ingressSourceCidrs?: string[] } = {},
): string {
  const ingressNamespace = options.ingressNamespace ?? 'kube-system';
  const sourceCidrs =
    options.ingressSourceCidrs ?? SANDBOX_INGRESS_SOURCE_CIDRS;
  const cidrBlocks = sourceCidrs
    .map((cidr) => `        - ipBlock:\n            cidr: ${cidr}`)
    .join('\n');
  return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-isolation
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
    flui.cloud/sandbox: "true"
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Traffic from the ingress controller, and from this tenancy to itself.
    - from:
        - podSelector: {}
        # Kept, and a no-op while Traefik is host-networked: it becomes the
        # precise rule again the day it stops being.
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${ingressNamespace}
${cidrBlocks}
  egress:
    # DNS, or nothing works at all.
    #
    # This selector holds only because CoreDNS is an ordinary pod. Host-network
    # it, or put a node-local DNS cache in front of it — those are host-network
    # by design — and kube-router stops matching it here exactly as it stopped
    # matching Traefik above, with no error: a guest's names simply stop
    # resolving, which reads as a broken demo rather than a policy that changed.
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # This tenancy talking to itself.
    - to:
        - podSelector: {}
    # The public internet, minus everything private and minus the metadata
    # service — the address that hands out node credentials on most providers.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
              - 127.0.0.0/8
`;
}
