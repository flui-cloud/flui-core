import * as yaml from 'js-yaml';

/**
 * What the documents of a manifest file declare: resources, owners, Secrets,
 * workloads and their images. Nothing here talks to a cluster or a filesystem.
 */

const OWNER_LABELS = ['flui.cloud/owner-kind', 'flui.cloud/owner-id'] as const;

/**
 * Deliberately not `localeCompare`: the order feeds a digest, and a digest that
 * depends on the machine's locale is a digest two machines disagree about.
 */
export const byBytes = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Parses, or throws with the parser's own complaint. */
export function documentsOf(content: string): unknown[] {
  return yaml.loadAll(content).filter((d) => d !== null && d !== undefined);
}

const asRecord = (doc: unknown): Record<string, unknown> =>
  typeof doc === 'object' && doc !== null
    ? (doc as Record<string, unknown>)
    : {};

/** A name off a manifest is whatever was written there; only a string is one. */
const nameOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Whether any document is a resource at all. */
export function declaresResource(docs: unknown[]): boolean {
  return docs.some((d) => 'kind' in asRecord(d));
}

export function carriesSecret(docs: unknown[]): boolean {
  return docs.some((d) => asRecord(d).kind === 'Secret');
}

/**
 * Every resource says who put it there, or the file is not ours to rewrite.
 *
 * `check-manifest-provenance.sh` makes this true of everything in the
 * repository and states the inverse: nothing k3s installs carries these labels.
 * So the label is the line between what a release may speak for and what it
 * may not.
 */
export function declaresProvenance(docs: unknown[]): boolean {
  const resources = docs.filter((d) => 'kind' in asRecord(d));
  if (resources.length === 0) return false;
  return resources.every((doc) => {
    const meta = asRecord(asRecord(doc).metadata);
    const labels = asRecord(meta.labels);
    return OWNER_LABELS.every((key) => Boolean(labels[key]));
  });
}

export interface ImageChange {
  workload: string;
  from: string;
  to: string;
}

/**
 * An image change on a workload that owns data.
 *
 * `02-postgres.yaml` passes every other test — no placeholder, ours, no Secret —
 * and names `postgres:15-alpine` beside a volume claim. Safe to *rewrite* is not
 * safe to *run*, and only the second one loses data.
 */
export function statefulImageChanges(
  current: unknown[],
  next: unknown[],
): ImageChange[] {
  return statefulImageChangesAgainst(workloadImages(current), next);
}

/** Against images known some other way — what the cluster is running. */
export function statefulImageChangesAgainst(
  before: ReadonlyMap<string, string>,
  next: unknown[],
): ImageChange[] {
  const changes: ImageChange[] = [];
  for (const [workload, { image, stateful }] of imagesByWorkload(next)) {
    if (!stateful) continue;
    const previous = before.get(workload);
    if (previous !== undefined && previous !== image) {
      changes.push({ workload, from: previous, to: image });
    }
  }
  return changes;
}

/** `Kind/name/container` → image, for every workload container in the documents. */
export function workloadImages(docs: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, { image }] of imagesByWorkload(docs)) out.set(key, image);
  return out;
}

export interface WorkloadRef {
  kind: string;
  name: string;
  namespace: string;
}

/** The workloads the documents declare, to read their live images by. */
export function workloadsOf(docs: unknown[]): WorkloadRef[] {
  return docs
    .map(asRecord)
    .filter(
      (d) =>
        d.kind === 'Deployment' ||
        d.kind === 'StatefulSet' ||
        d.kind === 'DaemonSet',
    )
    .map((d) => {
      const meta = asRecord(d.metadata);
      return {
        kind: nameOf(d.kind),
        name: nameOf(meta.name),
        namespace: nameOf(meta.namespace) || 'default',
      };
    });
}

/**
 * Every Secret a pod in these documents cannot start without, as
 * `namespace/name`. An `optional` reference is left out: its absence is a state
 * the workload was written to handle.
 */
export function requiredSecretsOf(docs: unknown[]): string[] {
  const found = new Set<string>();
  for (const doc of docs) {
    const d = asRecord(doc);
    const namespace = nameOf(asRecord(d.metadata).namespace) || 'default';
    const podSpec = asRecord(asRecord(asRecord(d.spec).template).spec);
    for (const [ref, key] of podSecretRefs(podSpec)) {
      const name = nameOf(ref[key]);
      if (name && ref.optional !== true) found.add(`${namespace}/${name}`);
    }
  }
  return [...found].sort(byBytes);
}

type SecretRef = [Record<string, unknown>, string];

function podSecretRefs(podSpec: Record<string, unknown>): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const volume of asArray(podSpec.volumes)) {
    const secret = asRecord(asRecord(volume).secret);
    if ('secretName' in secret) refs.push([secret, 'secretName']);
  }
  const containers = [
    ...asArray(podSpec.containers),
    ...asArray(podSpec.initContainers),
  ];
  for (const container of containers)
    refs.push(...containerSecretRefs(container));
  return refs;
}

function containerSecretRefs(container: unknown): SecretRef[] {
  const c = asRecord(container);
  const refs: SecretRef[] = [];
  for (const env of asArray(c.env)) {
    const ref = asRecord(asRecord(asRecord(env).valueFrom).secretKeyRef);
    if ('name' in ref) refs.push([ref, 'name']);
  }
  for (const source of asArray(c.envFrom)) {
    const ref = asRecord(asRecord(source).secretRef);
    if ('name' in ref) refs.push([ref, 'name']);
  }
  return refs;
}

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

function imagesByWorkload(
  docs: unknown[],
): Map<string, { image: string; stateful: boolean }> {
  const out = new Map<string, { image: string; stateful: boolean }>();
  for (const doc of docs) {
    const d = asRecord(doc);
    const kind = d.kind;
    if (
      kind !== 'Deployment' &&
      kind !== 'StatefulSet' &&
      kind !== 'DaemonSet'
    ) {
      continue;
    }
    const name = nameOf(asRecord(d.metadata).name);
    const spec = asRecord(d.spec);
    const podSpec = asRecord(asRecord(spec.template).spec);
    const containers = Array.isArray(podSpec.containers)
      ? podSpec.containers
      : [];
    const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes : [];
    const stateful =
      Array.isArray(spec.volumeClaimTemplates) ||
      volumes.some((v) => 'persistentVolumeClaim' in asRecord(v));
    for (const container of containers) {
      const image = asRecord(container).image;
      if (typeof image !== 'string') continue;
      const containerName = nameOf(asRecord(container).name);
      out.set(`${kind}/${name}/${containerName}`, {
        image,
        stateful,
      });
    }
  }
  return out;
}
