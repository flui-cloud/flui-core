jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: 'CoreV1Api',
}));

import { ClusterStorageUsageService } from './cluster-storage-usage.service';

/**
 * What a probe pod really prints, taken from the directory names
 * local-path writes: `pvc-<uid>_<namespace>_<claim>`.
 */
const LOGS = [
  'local\tpvc-9f2bda8f-9294-4b9c-baba-79d3829a0284_user-demo_data-shop-postgres-0\t5242880',
  'local\tpvc-2ae7c427-3713-4e7c-8347-035d4aa6f53e_user-demo_data-shop-nats-0\t1024',
  'shared\tpvc-89cad2a4-c2d1-4ba7-bf57-1f39f01273bc_user-guest-abc_memos-data\t2048',
  '',
].join('\n');

const build = () =>
  new ClusterStorageUsageService(
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as {
    parse: (logs: string, node: string) => Array<Record<string, unknown>>;
    foldByNamespace: (
      rows: Array<Record<string, unknown>>,
    ) => Array<Record<string, unknown>>;
  };

describe('reading what a probe measured', () => {
  it('turns a directory name into a tenancy and a volume', () => {
    const rows = build().parse(LOGS, 'master-1');

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      volumeName: 'data-shop-postgres-0',
      namespace: 'user-demo',
      kind: 'local',
      node: 'master-1',
      bytes: 5242880 * 1024,
    });
    expect(rows[2]).toMatchObject({
      namespace: 'user-guest-abc',
      kind: 'shared',
    });
  });

  /**
   * Attributing somebody else's data to a tenancy is worse than leaving a row
   * out, so anything whose name does not carry a namespace is dropped rather
   * than guessed at.
   */
  it('drops a directory it cannot attribute instead of guessing', () => {
    const rows = build().parse(
      ['local\tsomething-else\t100', 'local\tpvc-only-two_parts\t100'].join(
        '\n',
      ),
      'master-1',
    );

    expect(rows).toEqual([]);
  });

  it('ignores noise in the log without failing the measurement', () => {
    const rows = build().parse(
      ['warning: something', '', 'local\tpvc-a_ns_v\t10'].join('\n'),
      'n1',
    );

    expect(rows).toHaveLength(1);
  });

  it('adds a tenancy up across both its disks', () => {
    const service = build();
    const rows = service.parse(LOGS, 'master-1');
    const folded = service.foldByNamespace(rows);

    expect(folded[0]).toMatchObject({
      namespace: 'user-demo',
      volumes: 2,
      bytes: (5242880 + 1024) * 1024,
    });
    expect(folded[1]).toMatchObject({
      namespace: 'user-guest-abc',
      volumes: 1,
    });
  });
});
