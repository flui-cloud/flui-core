/**
 * The backup half of the example world: where copies are kept, on what
 * schedule, what the last runs did and what a restore looked like after it ran.
 *
 * Same organisation, same cluster and the same applications as everywhere else
 * — see `sandbox-world-core.ts`. Everything in a real tenancy is deleted in 24
 * hours by design, so there is nothing of the guest's to protect here; what the
 * section is for is showing that the capability exists and how it is written
 * down.
 *
 * The field names are the response shapes the screens actually read, not a
 * plausible-looking approximation of them: the first version of this file was
 * written from the shape of the section rather than from the model, and every
 * screen that rendered a status badge threw on a value that did not exist.
 */
import {
  APPS,
  CLUSTER_ID,
  CLUSTER_NAME,
  daysAgo,
  hoursAgo,
  mark,
  minutesAgo,
  ORG_NAME,
} from './sandbox-world-core';

const DESTINATION_ID = 'example-destination-1';
const NIGHTLY_ID = 'example-policy-1';
const HOURLY_ID = 'example-policy-2';

export function exampleBackupDestinations(now: number) {
  return [
    mark({
      id: DESTINATION_ID,
      userId: 'example',
      name: `${ORG_NAME} object storage`,
      provider: 'scaleway_object_storage',
      endpoint: 's3.fr-par.scw.cloud',
      region: 'fr-par',
      bucket: 'northwind-backups',
      pathPrefix: `clusters/${CLUSTER_NAME}`,
      // The keys this destination is reached with exist on the real object and
      // are never shown here, invented or otherwise.
      encryptionMode: 'flui_managed',
      useSse: true,
      forcePathStyle: false,
      usableForEtcdL1: true,
      healthStatus: 'healthy',
      lastHealthCheckAt: hoursAgo(now, 2),
      lastHealthError: null,
      usageBytes: '41233612800',
      usageRefreshedAt: hoursAgo(now, 2),
      costPerGbMonthCents: 1,
      createdAt: daysAgo(now, 24),
      updatedAt: hoursAgo(now, 2),
    }),
  ];
}

const destinationBinding = (policyId: string) => [
  mark({
    id: `${policyId}-destination`,
    destinationId: DESTINATION_ID,
    role: 'primary',
    priority: 1,
    enabled: true,
    lastReplicationStatus: 'ok',
  }),
];

export function exampleBackupPolicies(now: number) {
  return [
    mark({
      id: NIGHTLY_ID,
      userId: 'example',
      clusterId: CLUSTER_ID,
      name: 'Nightly, everything',
      scope: 'cluster_all',
      includePvcs: true,
      includeEtcdL1: true,
      cronSchedule: '0 2 * * *',
      retentionDays: 30,
      enabled: true,
      status: 'active',
      profile: 'single',
      destinations: destinationBinding(NIGHTLY_ID),
      createdAt: daysAgo(now, 24),
      updatedAt: hoursAgo(now, 3),
    }),
    mark({
      id: HOURLY_ID,
      userId: 'example',
      clusterId: CLUSTER_ID,
      name: 'Hourly, the orders database',
      scope: 'applications',
      scopeSelector: { applicationIds: [APPS[2].id] },
      includePvcs: false,
      includeEtcdL1: false,
      cronSchedule: '0 * * * *',
      retentionDays: 7,
      enabled: true,
      status: 'active',
      profile: 'single',
      destinations: destinationBinding(HOURLY_ID),
      createdAt: daysAgo(now, 24),
      updatedAt: minutesAgo(now, 34),
    }),
  ];
}

export function exampleRestoreJobs(now: number) {
  return [
    mark({
      id: 'example-restore-1',
      userId: 'example',
      artifactId: 'example-artifact-1',
      sourceDestinationId: DESTINATION_ID,
      targetClusterId: CLUSTER_ID,
      targetKind: 'application',
      targetSelector: { applicationId: APPS[2].id },
      strategy: 'pg_pitr',
      status: 'completed',
      createdAt: daysAgo(now, 4),
    }),
  ];
}

/**
 * The one-glance answer the Backup landing screen opens with. Healthy on
 * purpose: what this section demonstrates is a cluster that *is* protected, and
 * an invented alarm would be read as a real one.
 */
export function exampleBackupStatus(now: number) {
  return mark({
    overall: 'ok',
    summary: {
      clustersTotal: 1,
      clustersWithBackups: 1,
      clustersWithoutBackups: 0,
      activePolicies: 2,
      degradedPolicies: 0,
      failedDestinations: 0,
      healthyDestinations: 1,
      totalArtifactsLast30d: 58,
      failedJobsLast24h: 0,
    },
    lastSuccessfulBackupAt: minutesAgo(now, 34),
    alerts: [],
    generatedAt: new Date(now).toISOString(),
  });
}

/** The last few runs of the schedules above, newest first. */
export function exampleBackupJobs(now: number) {
  const runs = [
    { id: 'example-job-1', policyId: HOURLY_ID, minutes: 34 },
    { id: 'example-job-2', policyId: HOURLY_ID, minutes: 94 },
    { id: 'example-job-3', policyId: NIGHTLY_ID, minutes: 180 },
  ];
  return runs.map((run) =>
    mark({
      id: run.id,
      policyId: run.policyId,
      clusterId: CLUSTER_ID,
      userId: 'example',
      triggerType: 'scheduled',
      status: 'completed',
      startedAt: minutesAgo(now, run.minutes),
      finishedAt: minutesAgo(now, run.minutes - 2),
      createdAt: minutesAgo(now, run.minutes),
      updatedAt: minutesAgo(now, run.minutes - 2),
    }),
  );
}
