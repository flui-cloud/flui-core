/**
 * What Flui would change in an application's memory, and why — never applied
 * here. A person applies it, because a larger limit lets one application take
 * memory the machine promised to others, and a larger request can make the
 * fleet buy a node.
 *
 * Memory only: a container over its CPU limit is slowed, not stopped, and
 * replicas are the answer to that.
 */

export const NEAR_LIMIT_SHARE = 0.9;
export const ABOVE_REQUEST_FACTOR = 2;
export const HEADROOM_FACTOR = 1.5;
const STEP_MI = 64;

export type ProposalReasonKind = 'oom' | 'near-limit' | 'above-request';

export interface ProposalReason {
  kind: ProposalReasonKind;
  sentence: string;
}

export interface ProposalSignals {
  requestMi: number | null;
  limitMi: number | null;
  /** 95th percentile of memory use over the window; null when unread. */
  p95Mi: number | null;
  /** The limit an open out-of-memory diagnosis proposes. */
  oom: { limitMi: number; diagnosisId: string } | null;
}

export interface ProposedMemory {
  requestMi: number | null;
  limitMi: number | null;
  reasons: ProposalReason[];
  diagnosisId: string | null;
}

export function proposeMemory(signals: ProposalSignals): ProposedMemory | null {
  const { requestMi, limitMi, p95Mi, oom } = signals;
  const reasons: ProposalReason[] = [];
  let nextLimit = limitMi;
  let nextRequest = requestMi;

  if (oom && (limitMi === null || oom.limitMi > limitMi)) {
    nextLimit = oom.limitMi;
    reasons.push({
      kind: 'oom',
      sentence:
        limitMi === null
          ? 'It was stopped for running out of memory.'
          : `It was stopped for running out of memory at its ${mi(limitMi)} limit.`,
    });
  } else if (
    p95Mi !== null &&
    limitMi !== null &&
    p95Mi >= limitMi * NEAR_LIMIT_SHARE
  ) {
    nextLimit = Math.max(limitMi, roundUp(p95Mi * HEADROOM_FACTOR));
    reasons.push({
      kind: 'near-limit',
      sentence: `Most of the past week it used ${mi(p95Mi)}, close to its ${mi(limitMi)} limit.`,
    });
  }

  if (
    p95Mi !== null &&
    requestMi !== null &&
    requestMi > 0 &&
    p95Mi >= requestMi * ABOVE_REQUEST_FACTOR
  ) {
    nextRequest = roundUp(p95Mi);
    reasons.push({
      kind: 'above-request',
      sentence: `It reserves ${mi(requestMi)} but uses ${mi(p95Mi)}, so the node counts it as smaller than it is.`,
    });
  }

  if (!reasons.length) return null;
  if (nextRequest !== null && nextLimit !== null && nextLimit < nextRequest) {
    nextLimit = nextRequest;
  }
  return {
    requestMi: nextRequest,
    limitMi: nextLimit,
    reasons,
    diagnosisId: oom?.diagnosisId ?? null,
  };
}

/**
 * A larger limit is only used if the engine is allowed to use it; for the
 * engines Flui knows, the setting that decides it.
 */
export function engineMemoryNote(engine: string | null | undefined): string {
  switch (engine) {
    case 'postgres':
      return 'Postgres uses more memory only if shared_buffers and work_mem in its configuration are raised too.';
    case 'mariadb':
      return 'MariaDB uses more memory for data only if innodb_buffer_pool_size in its configuration is raised too.';
    case 'redis':
    case 'valkey':
      return 'If maxmemory is set in its configuration, it stays the ceiling whatever the limit is.';
    case 'opensearch':
      return 'OpenSearch uses more memory only if its Java heap (OPENSEARCH_JAVA_OPTS) is raised too.';
    case 'kafka':
      return 'Kafka uses more memory only if its Java heap (KAFKA_HEAP_OPTS) is raised too.';
    default:
      return 'The extra memory helps only if the application is allowed to use it: check its own memory settings.';
  }
}

export function formatMi(value: number): string {
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024}Gi`;
  return `${value}Mi`;
}

function roundUp(value: number): number {
  return Math.ceil(value / STEP_MI) * STEP_MI;
}

function mi(value: number | null): string {
  return value === null ? 'no limit' : formatMi(Math.round(value));
}
