/**
 * The example world a guest is shown where the real thing is not theirs to see.
 *
 * Sections like providers, networks, firewalls, DNS zones and backups belong to
 * the instance being borrowed. Refusing them wholesale loses the part of the
 * product a person evaluating Flui most wants to look at, so instead they are
 * answered from here.
 *
 * Five things hold this file together, and breaking any of them breaks the point
 * of it:
 *
 * 1. **It is not state.** Nothing here is written to a table. A fake provider in
 *    the database would be picked up by the reconcilers, which would try to talk
 *    to it, and a fake cluster would become a nameable target. This is a service
 *    that answers, not something that exists.
 * 2. **It is one world.** A single provider, three machines, one network, a
 *    firewall whose rules name those machines, a zone with its records, a couple
 *    of backups of the workload that runs on them. Sections that do not agree
 *    with each other read as broken rather than as a demonstration.
 * 3. **It is alive.** Every date is computed from `now`. A backup pinned to a
 *    fixed date is the oldest thing in the demo within a week.
 * 4. **It is declared.** Every object carries `sandboxExample: true`, so a
 *    caller reading a single element still knows. The response also carries the
 *    level header. There is no silent stand-in.
 * 5. **It never invents a secret.** No access keys, no SSH keys, no kubeconfig,
 *    no secret values — not even made-up ones. A fake credential is still a
 *    string shaped like a credential: it teaches the interface to print one, and
 *    in a screenshot it cannot be told from a real leak. The sections say those
 *    objects exist; they never show a value.
 *
 * Names are plausible on purpose. Mangling them would spoil the demonstration
 * without adding any honesty — the label is what does that job.
 */

import {
  CLUSTER_ID,
  CLUSTER_NAME,
  daysAgo,
  EXAMPLE_REGION,
  hoursAgo,
  inDays,
  mark,
  MACHINES,
  minutesAgo,
  NETWORK_RANGE,
  ORG_NAME,
  PROVIDER,
  REGION,
  REGION_NAME,
  SUBNET_RANGE,
  ZONE_NAME,
} from './sandbox-world-core';

export { SANDBOX_EXAMPLE_FLAG } from './sandbox-world-core';

export function exampleProviders(now: number) {
  return [
    mark({
      id: PROVIDER,
      name: PROVIDER,
      displayName: 'Hetzner Cloud',
      description:
        'European compute, used here as an example of a connected provider.',
      logoUrl: `/api/v1/management/providers/${PROVIDER}/logo`,
      websiteUrl: 'https://www.hetzner.com',
      documentationUrl: 'https://docs.hetzner.com',
      enabled: true,
      configured: true,
      pricingUrl: 'https://www.hetzner.com/cloud',
      capabilities: {
        compute: true,
        objectStorage: true,
        dns: true,
        loadBalancer: true,
        blockStorage: true,
        vnet: true,
      },
      availableRegions: [EXAMPLE_REGION],
      // No key, no token, not even an invented one: see the header of this file.
      configurationSchema: {},
      createdAt: daysAgo(now, 26),
      updatedAt: hoursAgo(now, 5),
    }),
  ];
}

export function exampleProviderConfigurations(now: number) {
  return [
    mark({
      id: 'example-provider-config-1',
      provider: PROVIDER,
      // `active` is what the interface counts as a working provider.
      status: 'active',
      isActive: true,
      enabledRegions: [REGION],
      availableRegions: [EXAMPLE_REGION],
      credentialsType: 'api_key',
      credentialsExpiresAt: null,
      lastHealthCheck: minutesAgo(now, 7),
      metadata: { accountName: ORG_NAME },
      createdAt: daysAgo(now, 26),
      updatedAt: hoursAgo(now, 5),
    }),
  ];
}

export function exampleInstances(now: number) {
  return {
    data: MACHINES.map((machine, index) =>
      mark({
        id: machine.id,
        userId: 'example',
        name: machine.name,
        displayName: machine.name,
        type: 'cloud',
        provider: PROVIDER,
        providerId: `example-${index + 1}`,
        status: 'running',
        dataCenter: `${REGION}-dc14`,
        region: REGION,
        regionName: REGION_NAME,
        cpuCores: machine.cpuCores,
        ramMb: machine.ramMb,
        diskMb: machine.diskMb,
        osType: 'Ubuntu 24.04',
        productName: machine.productName,
        productType: 'shared-vcpu',
        ownership: 'self',
        // The interface reads `ipConfig.v4.ip`. These addresses are in the
        // documentation range (RFC 5737) and belong to nothing.
        ipConfig: {
          v4: { ip: machine.publicIp, gateway: '203.0.113.1', netmaskCidr: 32 },
        },
        additionalIps: [machine.privateIp],
        createdAt: daysAgo(now, 26),
        updatedAt: minutesAgo(now, 4),
      }),
    ),
    partialErrors: [],
  };
}

export function exampleVNets(now: number) {
  const vnets = [
    mark({
      id: 'example-vnet-1',
      providerResourceId: 'example-net-1',
      name: 'northwind-net',
      provider: PROVIDER,
      ipRange: NETWORK_RANGE,
      status: 'ACTIVE',
      labels: [{ key: 'managed-by', value: 'flui' }],
      subnets: [
        mark({
          id: 'example-subnet-1',
          name: 'northwind-subnet',
          ipRange: SUBNET_RANGE,
          region: REGION,
          type: 'cloud',
          vnetId: 'example-vnet-1',
        }),
      ],
      routes: [],
      attachedServers: MACHINES.length,
      createdAt: daysAgo(now, 26),
      updatedAt: daysAgo(now, 26),
    }),
  ];
  return { vnets, total: vnets.length };
}

export function exampleFirewalls(now: number) {
  return [
    mark({
      id: 'example-firewall-1',
      name: 'northwind-edge',
      provider: PROVIDER,
      providerFirewallId: 'example-fw-1',
      clusterId: CLUSTER_ID,
      reconciliationStatus: 'IN_SYNC',
      coverageStatus: 'FULL',
      hasDrift: false,
      // The rules are applied to the machines above. Sections that do not agree
      // with each other read as broken rather than as a demonstration.
      clusterInfo: {
        clusterName: CLUSTER_NAME,
        clusterStatus: 'ready',
        totalNodes: MACHINES.length,
        readyNodes: MACHINES.length,
        nodes: MACHINES.map((m) => ({
          nodeId: m.id,
          serverName: m.name,
          nodeType: m.role,
          status: 'ready',
          ipAddress: m.privateIp,
        })),
      },
      desiredRules: [
        mark({
          id: 'allow-https',
          direction: 'in',
          protocol: 'tcp',
          port: '443',
          sourceIps: ['0.0.0.0/0', '::/0'],
          description: 'HTTPS from anywhere',
        }),
        mark({
          id: 'allow-http',
          direction: 'in',
          protocol: 'tcp',
          port: '80',
          sourceIps: ['0.0.0.0/0', '::/0'],
          description: 'HTTP, redirected to HTTPS',
        }),
        mark({
          id: 'allow-kube-api',
          direction: 'in',
          protocol: 'tcp',
          port: '6443',
          sourceIps: [SUBNET_RANGE],
          description: 'Kubernetes API, inside the network only',
        }),
        mark({
          id: 'allow-ssh',
          direction: 'in',
          protocol: 'tcp',
          port: '22',
          sourceIps: [SUBNET_RANGE],
          description: 'SSH, inside the network only',
        }),
      ],
      lastReconciliationAt: minutesAgo(now, 12),
      createdAt: daysAgo(now, 26),
      updatedAt: minutesAgo(now, 12),
    }),
  ];
}

export function exampleDnsZones(now: number) {
  return [
    mark({
      id: 'example-zone-1',
      providerZoneId: 'example-zone-1',
      zoneName: ZONE_NAME,
      dnsProvider: PROVIDER,
      description: 'The zone the example applications are published under.',
      recordTtlSeconds: 300,
      recordCount: 6,
      replicas: [],
      assignedClusters: [mark({ id: CLUSTER_ID, name: CLUSTER_NAME })],
      wildcardCertificate: {
        status: 'valid',
        issuer: "Let's Encrypt",
        expiresAt: inDays(now, 67),
      },
      createdAt: daysAgo(now, 26),
      updatedAt: hoursAgo(now, 9),
    }),
  ];
}

/**
 * The regions the example provider offers. One, the same one the machines and
 * the provider configuration name — a provider detail screen that lists regions
 * the rest of the world never mentions is a section arguing with itself.
 */
export function exampleProviderRegions() {
  return [EXAMPLE_REGION];
}
