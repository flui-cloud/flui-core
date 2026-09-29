import {
  DependencyEntry,
  holdBackUnmetDependencies,
  priorityClassesDefinedBy,
  priorityClassesUsedBy,
} from './manifest-dependencies.util';

const PRIORITY = `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: flui-platform
value: 1000000
`;

const statefulSet = (priority?: string): string => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  template:
    spec:
${priority ? `      priorityClassName: ${priority}\n` : ''}      containers:
        - name: postgres
          image: postgres:15-alpine
`;

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, { content: v }]));

describe('priority classes a manifest uses and defines', () => {
  it('reads the class off a workload template, a pod and a cron job', () => {
    expect(priorityClassesUsedBy(statefulSet('flui-platform'))).toEqual([
      'flui-platform',
    ]);
    expect(
      priorityClassesUsedBy(
        'kind: Pod\nspec:\n  priorityClassName: a\n  containers: []\n',
      ),
    ).toEqual(['a']);
    expect(
      priorityClassesUsedBy(
        'kind: CronJob\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          priorityClassName: b\n',
      ),
    ).toEqual(['b']);
  });

  it('ignores the classes every cluster has', () => {
    expect(priorityClassesUsedBy(statefulSet('system-node-critical'))).toEqual(
      [],
    );
  });

  it('finds the class a file defines', () => {
    expect(priorityClassesDefinedBy(PRIORITY)).toEqual(['flui-platform']);
  });

  it('treats a file that does not parse as using and defining nothing', () => {
    expect(priorityClassesUsedBy('a: [')).toEqual([]);
    expect(priorityClassesDefinedBy(undefined)).toEqual([]);
  });
});

describe('holding back a file whose PriorityClass does not reach the cluster', () => {
  const release = files({
    '01b-platform-priority.yaml': PRIORITY,
    '02-postgres.yaml': statefulSet('flui-platform'),
  });

  it('skips a workload when the file defining its class is left alone and absent from the master', () => {
    const entries: DependencyEntry[] = [
      { name: '01b-platform-priority.yaml', action: 'skip', reason: 'x' },
      { name: '02-postgres.yaml', action: 'replace', currentSha: 'a' },
    ];
    const [, postgres] = holdBackUnmetDependencies(entries, release);
    expect(postgres.action).toBe('skip');
    expect(postgres.reason).toContain('PriorityClass flui-platform');
    expect(postgres.reason).toContain('01b-platform-priority.yaml');
  });

  it('writes the workload when the same refresh adds the class', () => {
    const entries: DependencyEntry[] = [
      { name: '01b-platform-priority.yaml', action: 'add' },
      { name: '02-postgres.yaml', action: 'replace', currentSha: 'a' },
    ];
    const out = holdBackUnmetDependencies(entries, release);
    expect(out.map((e) => e.action)).toEqual(['add', 'replace']);
  });

  it('writes the workload when the master already holds the defining file', () => {
    for (const action of ['unchanged', 'skip'] as const) {
      const entries: DependencyEntry[] = [
        { name: '01b-platform-priority.yaml', action, currentSha: 'b' },
        { name: '02-postgres.yaml', action: 'replace', currentSha: 'a' },
      ];
      expect(holdBackUnmetDependencies(entries, release)[1].action).toBe(
        'replace',
      );
    }
  });

  it('skips a workload whose class no file of the release defines', () => {
    const out = holdBackUnmetDependencies(
      [{ name: 'app.yaml', action: 'add' }] as DependencyEntry[],
      files({ 'app.yaml': statefulSet('nowhere') }),
    );
    expect(out[0].action).toBe('skip');
    expect(out[0].reason).toContain('no file of this release defines it');
  });

  it('follows a chain: a class defined only by a file that is itself held back', () => {
    const chained = files({
      'a-priority.yaml': `${PRIORITY}---\n${statefulSet('other')}`,
      'b-app.yaml': statefulSet('flui-platform'),
    });
    const out = holdBackUnmetDependencies(
      [
        { name: 'a-priority.yaml', action: 'add' },
        { name: 'b-app.yaml', action: 'replace', currentSha: 'a' },
      ],
      chained,
    );
    expect(out.map((e) => e.action)).toEqual(['skip', 'skip']);
  });

  it('leaves files that use no class alone', () => {
    const entries: DependencyEntry[] = [
      { name: '03-redis.yaml', action: 'replace', currentSha: 'a' },
    ];
    expect(
      holdBackUnmetDependencies(
        entries,
        files({ '03-redis.yaml': statefulSet() }),
      ),
    ).toEqual(entries);
  });
});
