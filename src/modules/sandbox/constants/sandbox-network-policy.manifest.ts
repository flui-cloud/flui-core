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
export function buildSandboxNetworkPolicy(
  namespace: string,
  ingressNamespace = 'kube-system',
): string {
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
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${ingressNamespace}
        - podSelector: {}
  egress:
    # DNS, or nothing works at all.
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
