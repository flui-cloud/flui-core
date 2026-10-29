import { runningPodForDatabase } from './database-pod.util';

const pod = (name: string, phase: string, role?: string) => ({
  name,
  metadata: { labels: role ? { 'cnpg.io/instanceRole': role } : {} },
  status: { phase },
});

describe('the pod a database command reaches', () => {
  it('is the first running pod when nothing says which one leads', () => {
    expect(
      runningPodForDatabase([
        pod('a', 'Pending'),
        pod('b', 'Running'),
        pod('c', 'Running'),
      ])?.name,
    ).toBe('b');
  });

  /** A copy refuses writes and reports another disk, so it is never the one a person means. */
  it('is the primary of a highly available Postgres, wherever it sits in the list', () => {
    expect(
      runningPodForDatabase([
        pod('db-1', 'Running', 'replica'),
        pod('db-2', 'Running', 'primary'),
      ])?.name,
    ).toBe('db-2');
  });

  it('falls back to a running copy while the primary is not running', () => {
    expect(
      runningPodForDatabase([
        pod('db-1', 'Running', 'replica'),
        pod('db-2', 'Pending', 'primary'),
      ])?.name,
    ).toBe('db-1');
  });

  it('is nothing when no pod runs', () => {
    expect(runningPodForDatabase([pod('a', 'Failed')])).toBeUndefined();
  });
});
