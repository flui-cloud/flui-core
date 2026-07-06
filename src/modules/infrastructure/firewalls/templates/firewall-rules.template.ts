import { FirewallRule } from '../../../providers/interfaces/firewall-provider.interface';

/**
 * Firewall rules — public surface only.
 *
 * Intra-cluster and inter-cluster traffic (Prometheus scrape, Loki ingest,
 * kubelet, K3s API, DB/Redis NodePorts, ClusterIP services) flows over the
 * environment VNet/Subnet and never touches the public interface.
 *
 * Observability + workload cluster public ports:
 *   22     SSH (management, sourceCidrs)
 *   80     Traefik HTTP (api/app/auth via nip.io ingress)
 *   443    Traefik HTTPS
 */
export const CONTROL_FIREWALL_RULES = (
  sourceCidrs: string[],
): FirewallRule[] => [
  {
    description: 'SSH access for server management',
    direction: 'in',
    protocol: 'tcp',
    port: '22',
    sourceIps: sourceCidrs,
  },
  {
    description: 'HTTP Ingress (Traefik)',
    direction: 'in',
    protocol: 'tcp',
    port: '80',
    sourceIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'HTTPS Ingress (Traefik)',
    direction: 'in',
    protocol: 'tcp',
    port: '443',
    sourceIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'Allow all outbound TCP traffic',
    direction: 'out',
    protocol: 'tcp',
    destinationIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'Allow all outbound UDP traffic',
    direction: 'out',
    protocol: 'udp',
    destinationIps: ['0.0.0.0/0', '::/0'],
  },
];

export const WORKLOAD_FIREWALL_RULES = (
  sourceCidrs: string[],
): FirewallRule[] => [
  {
    description: 'SSH access for cluster management',
    direction: 'in',
    protocol: 'tcp',
    port: '22',
    sourceIps: sourceCidrs,
  },
  {
    description: 'HTTP Ingress (Traefik)',
    direction: 'in',
    protocol: 'tcp',
    port: '80',
    sourceIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'HTTPS Ingress (Traefik)',
    direction: 'in',
    protocol: 'tcp',
    port: '443',
    sourceIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'Allow all outbound TCP traffic',
    direction: 'out',
    protocol: 'tcp',
    destinationIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'Allow all outbound UDP traffic',
    direction: 'out',
    protocol: 'udp',
    destinationIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'Allow all outbound ICMP (for ping, traceroute)',
    direction: 'out',
    protocol: 'icmp',
    destinationIps: ['0.0.0.0/0', '::/0'],
  },
];

export const OBSERVABILITY_PORTS = {
  SSH: { port: 22, protocol: 'tcp', description: 'SSH management' },
  HTTP_INGRESS: {
    port: 80,
    protocol: 'tcp',
    description: 'HTTP Ingress (Traefik)',
  },
  HTTPS_INGRESS: {
    port: 443,
    protocol: 'tcp',
    description: 'HTTPS Ingress (Traefik)',
  },
} as const;

export const WORKLOAD_PORTS = {
  SSH: { port: 22, protocol: 'tcp', description: 'SSH management' },
  HTTP_INGRESS: {
    port: 80,
    protocol: 'tcp',
    description: 'HTTP Ingress (Traefik)',
  },
  HTTPS_INGRESS: {
    port: 443,
    protocol: 'tcp',
    description: 'HTTPS Ingress (Traefik)',
  },
} as const;

export function validateFirewallRules(rules: FirewallRule[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const hasSshAccess = rules.some(
    (r) => r.direction === 'in' && r.protocol === 'tcp' && r.port === '22',
  );
  if (!hasSshAccess) {
    errors.push(
      'Firewall must include SSH access (port 22) to prevent server lockout',
    );
  }

  const hasOutbound = rules.some((r) => r.direction === 'out');
  if (!hasOutbound) {
    errors.push(
      'Firewall must allow outbound traffic for system updates and package installation',
    );
  }

  rules.forEach((rule, index) => {
    if (rule.sourceIps) {
      rule.sourceIps.forEach((cidr) => {
        if (!isValidCidr(cidr)) {
          errors.push(`Invalid CIDR format in rule ${index + 1}: ${cidr}`);
        }
      });
    }
    if (rule.destinationIps) {
      rule.destinationIps.forEach((cidr) => {
        if (!isValidCidr(cidr)) {
          errors.push(`Invalid CIDR format in rule ${index + 1}: ${cidr}`);
        }
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function sanitizeApiServerFirewallRules(
  rules: FirewallRule[],
  subnetCidr: string,
): FirewallRule[] {
  // The K3s API on 6443 is client-cert mTLS, so an open port grants nothing
  // without the kubeconfig cert (same reasoning the cross-provider reconciler
  // uses to open 6443 to the control's public IP). We therefore keep the
  // caller's explicit sources — a cross-provider control/dev machine legitimately
  // needs to reach 6443 from outside the VNet — while always guaranteeing the
  // subnet CIDR is present so intra-cluster/same-VNet reachability can't be lost.
  return rules.map((rule) =>
    rule.direction === 'in' && rule.protocol === 'tcp' && rule.port === '6443'
      ? {
          ...rule,
          sourceIps: Array.from(
            new Set([subnetCidr, ...(rule.sourceIps ?? [])]),
          ),
        }
      : rule,
  );
}

function isValidCidr(cidr: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  const ipv6Regex = /^([0-9a-fA-F:]+)\/\d{1,3}$/;
  return ipv4Regex.test(cidr) || ipv6Regex.test(cidr);
}

export function getFirewallRulesForClusterType(
  clusterType: 'control' | 'observability' | 'workload',
  sourceCidrs: string[],
): FirewallRule[] {
  switch (clusterType) {
    case 'control':
    case 'observability':
      return CONTROL_FIREWALL_RULES(sourceCidrs);
    case 'workload':
      return WORKLOAD_FIREWALL_RULES(sourceCidrs);
    default:
      return WORKLOAD_FIREWALL_RULES(sourceCidrs);
  }
}
