import {
  copiesFromStoragePools,
  diskFromSummary,
  diskWarnings,
} from './node-disks.core';

describe('the space left on the nodes', () => {
  it('reads the disk from the kubelet summary', () => {
    expect(
      diskFromSummary({
        node: {
          fs: {
            capacityBytes: 40 * 1024 ** 3,
            availableBytes: 21.5 * 1024 ** 3,
          },
        },
      }),
    ).toEqual({ totalGiB: 40, freeGiB: 21.5 });
    expect(diskFromSummary({ node: {} })).toBeNull();
  });

  it('reads the space for copies from LINSTOR, the pool of replicated volumes only', () => {
    const json = JSON.stringify([
      [
        {
          storage_pool_name: 'flui-replicated',
          node_name: 'w1',
          free_capacity: 15 * 1024 ** 2,
          total_capacity: 20 * 1024 ** 2,
        },
        {
          storage_pool_name: 'DfltDisklessStorPool',
          node_name: 'w3',
          free_capacity: 0,
          total_capacity: 0,
        },
      ],
    ]);
    expect([...copiesFromStoragePools(json, 'flui-replicated')]).toEqual([
      ['w1', { totalGiB: 20, freeGiB: 15 }],
    ]);
  });

  it('warns on a disk or a space for copies running short, and stays quiet otherwise', () => {
    const warnings = diskWarnings([
      {
        node: 'w1',
        zone: 'nbg1',
        disk: { totalGiB: 40, freeGiB: 4 },
        copies: { totalGiB: 20, freeGiB: 1.5 },
      },
      {
        node: 'w2',
        zone: 'fsn1',
        disk: { totalGiB: 40, freeGiB: 20 },
        copies: { totalGiB: 20, freeGiB: 12 },
      },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('w1 has 4 of 40 GiB free on its disk');
    expect(warnings[1]).toContain('w1 has 1.5 of 20 GiB free for copies');
  });
});
