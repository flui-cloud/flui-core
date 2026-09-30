import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * A control-cluster volume is local to the node that created it, and on a
 * single-node install that node is the master. Master protection taints the
 * master once a worker joins, so a workload holding such a volume that does not
 * tolerate the taint cannot come back the next time its pod is recreated — an
 * update, an eviction, a restart. That is how a platform update once left the
 * control database Pending.
 */
const BOOTSTRAP = join(
  __dirname,
  '../../../../../bootstrap-scripts/manifests/control',
);
const ifTemplates = existsSync(BOOTSTRAP) ? describe : describe.skip;

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

type Doc = Record<string, any>;

function docs(file: string): Doc[] {
  const text = readFileSync(join(BOOTSTRAP, file), 'utf8').replace(
    /\$\{[A-Z0-9_]+\}/g,
    'x',
  );
  return yaml.loadAll(text).filter(Boolean) as Doc[];
}

function holdsVolume(doc: Doc): boolean {
  const spec = doc.spec ?? {};
  const volumes: Doc[] = spec.template?.spec?.volumes ?? [];
  return (
    volumes.some((v) => v.persistentVolumeClaim) ||
    (spec.volumeClaimTemplates ?? []).length > 0
  );
}

function toleratesMaster(doc: Doc): boolean {
  const tolerations: Doc[] = doc.spec?.template?.spec?.tolerations ?? [];
  return tolerations.some(
    (t) =>
      (t.key === 'node-role.kubernetes.io/control-plane' &&
        (t.operator === 'Exists' || t.operator === undefined) &&
        (t.effect === 'NoSchedule' || t.effect === undefined)) ||
      (t.operator === 'Exists' && t.key === undefined),
  );
}

ifTemplates('control manifests and master protection', () => {
  const withVolume = readdirSync(BOOTSTRAP)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((file) =>
      docs(file)
        .filter((d) => WORKLOADS.has(d.kind) && holdsVolume(d))
        .map((d) => ({ file, name: d.metadata?.name as string, doc: d })),
    );

  it('finds the workloads that hold a volume', () => {
    expect(withVolume.map((w) => w.name)).toEqual(
      expect.arrayContaining(['postgres']),
    );
  });

  it.each(withVolume.map((w) => [w.file, w.name, w.doc] as const))(
    '%s: %s tolerates the master taint',
    (_file, _name, doc) => {
      expect(toleratesMaster(doc)).toBe(true);
    },
  );
});
