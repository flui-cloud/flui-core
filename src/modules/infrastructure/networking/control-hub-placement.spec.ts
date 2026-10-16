import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';

/**
 * Every control node is an end of the Flui network so that the API can run
 * on any of them. Pinning it back to the master would hide a broken end on a
 * worker until the day the master is drained — the guard is here so nobody
 * does that as a "fix".
 */
const MANIFEST = join(
  __dirname,
  '../../../../../bootstrap-scripts/manifests/control/09-flui-api.yaml',
);
const ifManifest = existsSync(MANIFEST) ? describe : describe.skip;

const MASTER = /master|control-plane/i;

ifManifest('where the API may run', () => {
  const deployment = () => {
    const raw = readFileSync(MANIFEST, 'utf8').replace(
      /\$\{[A-Z0-9_]+\}/g,
      'x',
    );
    const docs = loadAll(raw) as any[];
    return docs.find(
      (d) => d?.kind === 'Deployment' && d?.metadata?.name === 'flui-api',
    );
  };

  it('is not pinned to a node by name', () => {
    expect(deployment().spec.template.spec.nodeName).toBeUndefined();
  });

  it('selects no master or control-plane node', () => {
    const selector = deployment().spec.template.spec.nodeSelector ?? {};
    expect(
      Object.entries(selector).some(
        ([k, v]) => MASTER.test(k) || MASTER.test(String(v)),
      ),
    ).toBe(false);
  });

  it('requires no master or control-plane node through affinity', () => {
    const required =
      deployment().spec.template.spec.affinity?.nodeAffinity
        ?.requiredDuringSchedulingIgnoredDuringExecution;
    expect(JSON.stringify(required ?? {})).not.toMatch(MASTER);
  });

  it('spreads its copies across nodes', () => {
    const anti =
      deployment().spec.template.spec.affinity?.podAntiAffinity ?? {};
    expect(JSON.stringify(anti)).toContain('kubernetes.io/hostname');
  });
});
