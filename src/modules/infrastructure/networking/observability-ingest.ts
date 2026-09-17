/**
 * The NodePorts a workload pushes its telemetry to on the control cluster.
 *
 * One list, read by the rule that admits this traffic over the tunnel and by
 * the rule that admits it from a public address. Two lists would drift, and the
 * cost of drifting is silent: telemetry is pushed at a port nothing admits, and
 * the only symptom is a cluster whose metrics never appear.
 *
 * Taken from the running services rather than assumed: `loki` 3100:30100 and
 * `vmsingle` 8428:30428, both pinned by convention so the last two digits echo
 * the service port.
 */
const DEFAULT_INGEST_NODEPORTS = '30100,30428';
const NODEPORT_MIN = 30000;
const NODEPORT_MAX = 32767;

export interface IngestPortsReport {
  ports: number[];
  /** Entries that were not usable NodePorts, so a caller can say so out loud. */
  rejected: string[];
}

/**
 * A typo must never open an arbitrary control-plane port — 22, 6443 and 5432
 * all sit outside the NodePort range, so the range check is what keeps a
 * mistyped variable from becoming a hole rather than a no-op.
 */
export function observabilityIngestPorts(
  raw = process.env.FLUI_OBS_INGEST_NODEPORTS || DEFAULT_INGEST_NODEPORTS,
): IngestPortsReport {
  const ports: number[] = [];
  const rejected: string[] = [];
  for (const entry of raw.split(',').map((s) => s.trim())) {
    if (!entry) continue;
    const n = Number(entry);
    if (Number.isInteger(n) && n >= NODEPORT_MIN && n <= NODEPORT_MAX) {
      ports.push(n);
    } else {
      rejected.push(entry);
    }
  }
  return { ports: [...new Set(ports)], rejected };
}

export { NODEPORT_MIN, NODEPORT_MAX };
