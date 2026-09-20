import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  carriesSecret,
  declaresProvenance,
  documentsOf,
  judge,
  placeholdersIn,
  planDigest,
  statefulImageChanges,
} from './manifest-eligibility.util';

/**
 * The fixtures are the real templates, when this machine has them beside the
 * repo. A rule about what is safe to write onto somebody's master, tested only
 * against files invented for the test, proves that the test agrees with itself.
 */
const BOOTSTRAP = join(__dirname, '../../../../../bootstrap-scripts/manifests');
const haveTemplates = existsSync(BOOTSTRAP);
const template = (rel: string) => readFileSync(join(BOOTSTRAP, rel), 'utf8');
const ifTemplates = haveTemplates ? describe : describe.skip;

const owned = (extra = '') => `apiVersion: v1
kind: ConfigMap
metadata:
  name: demo
  labels:
    flui.cloud/owner-kind: platform
    flui.cloud/owner-id: flui
data:
  a: "1"${extra}
`;

describe('what a placeholder is', () => {
  it('counts the braced form, which is the one the installer substitutes', () => {
    expect(
      placeholdersIn('host: ${FLUI_BASE_DOMAIN}\ntag: ${FLUI_API_IMAGE_TAG}'),
    ).toEqual(['FLUI_API_IMAGE_TAG', 'FLUI_BASE_DOMAIN']);
  });

  /**
   * The rule that decides whether `04c-vmalert.yaml` can ever be refreshed.
   * Its 16 alert annotations read `{{ $labels.namespace }}`; counting those as
   * variables would make the file that needs this command most permanently
   * ineligible.
   */
  it('leaves a bare $name alone — it belongs to whoever wrote the file', () => {
    expect(
      placeholdersIn('summary: "{{ $labels.namespace }} is down"'),
    ).toEqual([]);
  });

  it('ignores a positional, which no installer ever sets', () => {
    expect(placeholdersIn('cmd: ${1}')).toEqual([]);
  });
});

describe('what may not be rewritten', () => {
  it('refuses a file carrying a Secret, whatever it is called', () => {
    const doc = `apiVersion: v1
kind: Secret
metadata:
  name: anything
  labels:
    flui.cloud/owner-kind: platform
    flui.cloud/owner-id: flui
stringData:
  A: b
`;
    expect(carriesSecret(documentsOf(doc))).toBe(true);
    expect(
      judge({ name: 'x.yaml', release: doc, declaredByRelease: true }).reason,
    ).toMatch(/carries a Secret/);
  });

  /**
   * The master's copy is what holds the live credential. A release whose copy
   * looks innocent must not be allowed to overwrite one that is not, so the
   * reader that saw the master tells us and we believe it.
   */
  it('refuses when the master’s copy is the one with the Secret', () => {
    const verdict = judge({
      name: 'x.yaml',
      release: owned(),
      current: owned('\n  b: "2"'),
      currentCarriesSecret: true,
      declaredByRelease: true,
    });
    expect(verdict.action).toBe('skip');
    expect(verdict.reason).toMatch(/carries a Secret/);
  });

  it('refuses a file that declares no owner, because that is how k3s files look', () => {
    const k3sish = `apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
data: {}
`;
    expect(declaresProvenance(documentsOf(k3sish))).toBe(false);
    expect(
      judge({ name: 'coredns.yaml', release: k3sish, declaredByRelease: true })
        .reason,
    ).toMatch(/no flui.cloud\/owner-kind/);
  });

  it('refuses anything that would need a value, and names the values', () => {
    const verdict = judge({
      name: '09-flui-api.yaml',
      release: owned(
        '\n  host: ${FLUI_BASE_DOMAIN}\n  tag: ${FLUI_API_IMAGE_TAG}',
      ),
      current: owned(),
      declaredByRelease: true,
    });
    expect(verdict.action).toBe('skip');
    expect(verdict.placeholders).toEqual([
      'FLUI_API_IMAGE_TAG',
      'FLUI_BASE_DOMAIN',
    ]);
    expect(verdict.reason).toMatch(/supplies no values/);
  });
});

describe('an image change on something that holds data', () => {
  const pg = (tag: string) => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  labels:
    flui.cloud/owner-kind: platform
    flui.cloud/owner-id: flui
spec:
  volumeClaimTemplates:
    - metadata:
        name: data
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:${tag}
`;

  it('is refused by default, and says which image moved where', () => {
    const verdict = judge({
      name: '02-postgres.yaml',
      release: pg('16-alpine'),
      current: pg('15-alpine'),
      declaredByRelease: true,
    });
    expect(verdict.action).toBe('skip');
    expect(verdict.statefulImageChanges).toEqual([
      {
        workload: 'StatefulSet/postgres/postgres',
        from: 'postgres:15-alpine',
        to: 'postgres:16-alpine',
      },
    ]);
  });

  it('goes through when somebody says they have read the release notes', () => {
    const verdict = judge(
      {
        name: '02-postgres.yaml',
        release: pg('16-alpine'),
        current: pg('15-alpine'),
        declaredByRelease: true,
      },
      { allowStatefulImageChange: true },
    );
    expect(verdict.action).toBe('replace');
  });

  it('does not fire for a workload that holds nothing', () => {
    const redis = (tag: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  labels:
    flui.cloud/owner-kind: platform
    flui.cloud/owner-id: flui
spec:
  template:
    spec:
      containers:
        - name: redis
          image: redis:${tag}
`;
    expect(
      statefulImageChanges(documentsOf(redis('7')), documentsOf(redis('8'))),
    ).toEqual([]);
    expect(
      judge({
        name: '03-redis.yaml',
        release: redis('8'),
        current: redis('7'),
        declaredByRelease: true,
      }).action,
    ).toBe('replace');
  });
});

describe('adding a file the master does not have', () => {
  it('adds it when the release declares it', () => {
    expect(
      judge({ name: 'new.yaml', release: owned(), declaredByRelease: true })
        .action,
    ).toBe('add');
  });

  /**
   * Without this, a refresh would put `05-prometheus.yaml` back on a cluster
   * that runs VictoriaMetrics: the file is legacy, still in the repository, and
   * declares no placeholder, so every other rule waves it through.
   */
  it('refuses to add one the release does not declare', () => {
    const verdict = judge({
      name: '05-prometheus.yaml',
      release: owned(),
      declaredByRelease: false,
    });
    expect(verdict.action).toBe('skip');
    expect(verdict.reason).toMatch(/not declared in this release index/);
  });
});

describe('the plan digest', () => {
  const entries = [
    {
      name: 'a.yaml',
      action: 'replace' as const,
      currentSha: 'aa',
      releaseSha: 'bb',
    },
    { name: 'b.yaml', action: 'add' as const, releaseSha: 'cc' },
  ];

  it('does not depend on the order the files were listed in', () => {
    expect(planDigest('c0ffee', entries)).toBe(
      planDigest('c0ffee', [...entries].reverse()),
    );
  });

  it('changes when the master changed under us', () => {
    const moved = [{ ...entries[0], currentSha: 'a9' }, entries[1]];
    expect(planDigest('c0ffee', moved)).not.toBe(planDigest('c0ffee', entries));
  });

  it('changes when the release changed', () => {
    expect(planDigest('deadbe', entries)).not.toBe(
      planDigest('c0ffee', entries),
    );
  });
});

ifTemplates('against the real templates', () => {
  /**
   * Reproduces the live damage exactly. Bare `envsubst` blanked `$labels` at
   * install, so every master holds the same file with `{{ .namespace }}` where
   * `{{ $labels.namespace }} `was written. That is the copy this command has to
   * be willing to replace, and the reason it exists.
   */
  it('replaces the alert rules a past install mangled — the file this exists for', () => {
    const release = template('control/04c-vmalert.yaml');
    const asInstalled = release.replace(/\$labels/g, '');

    expect(placeholdersIn(release)).toEqual([]);
    expect(carriesSecret(documentsOf(release))).toBe(false);
    expect(declaresProvenance(documentsOf(release))).toBe(true);

    expect(asInstalled).not.toBe(release);
    expect(asInstalled).toContain('{{ .namespace }}');
    expect(declaresProvenance(documentsOf(asInstalled))).toBe(true);

    const verdict = judge({
      name: '04c-vmalert.yaml',
      release,
      current: asInstalled,
      declaredByRelease: true,
    });
    expect(verdict.action).toBe('replace');
    expect(verdict.statefulImageChanges).toEqual([]);
  });

  /**
   * A parsing copy with no owner label is somebody else's file, and the command
   * says so rather than claiming it. A copy that does not parse at all is the
   * opposite case — k3s is failing on it right now — and is replaced.
   */
  it('will not claim a file the master holds without provenance', () => {
    const release = template('control/04c-vmalert.yaml');
    expect(
      judge({
        name: '04c-vmalert.yaml',
        release,
        current: 'kind: ConfigMap\nmetadata:\n  name: x\n',
        declaredByRelease: true,
      }).reason,
    ).toMatch(/declares no provenance/);
    expect(
      judge({
        name: '04c-vmalert.yaml',
        release,
        current: 'kind: [unclosed',
        declaredByRelease: true,
      }).action,
    ).toBe('replace');
  });

  it('keeps its hands off both files that carry a Secret', () => {
    for (const name of ['00-secrets.yaml', '11-zitadel.yaml']) {
      const release = template(`control/${name}`);
      expect(judge({ name, release, declaredByRelease: true }).reason).toMatch(
        /carries a Secret/,
      );
    }
  });

  /**
   * Snapshot rather than assertion: this is the whole point of the command, and
   * a placeholder appearing in a file that had none must fail here rather than
   * quietly shrink what a refresh can fix.
   */
  it('classifies every control template exactly as recorded', () => {
    const verdicts: Record<string, string> = {};
    for (const file of readdirSync(join(BOOTSTRAP, 'control')).sort()) {
      if (!file.endsWith('.yaml')) continue;
      const release = template(`control/${file}`);
      const needs = placeholdersIn(release);
      verdicts[file] = needs.length
        ? `needs ${needs.length}`
        : 'no values needed';
    }
    expect(verdicts).toMatchSnapshot();
  });
});
