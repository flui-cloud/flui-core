import { orphanPoliciesAlert } from './orphan-policies.alert';

describe('orphanPoliciesAlert', () => {
  it('is absent when every policy has its cluster', () => {
    expect(orphanPoliciesAlert([])).toBeNull();
  });

  it('names the one policy and opens it', () => {
    expect(
      orphanPoliciesAlert([{ id: 'p1', name: 'prod-daily' }]),
    ).toMatchObject({
      message: expect.stringContaining('Backup policy prod-daily points'),
      ctaLabel: 'Open policy',
      ctaPath: '/management/backup/policies/p1',
      items: [
        {
          id: 'p1',
          name: 'prod-daily',
          path: '/management/backup/policies/p1',
        },
      ],
    });
  });

  it('names the first three and counts the rest, listing each one', () => {
    const alert = orphanPoliciesAlert(
      ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `policy-${id}` })),
    );
    expect(alert?.message).toContain(
      '4 backup policies point at a cluster that no longer exists: policy-a, policy-b, policy-c and 1 more.',
    );
    expect(alert?.ctaPath).toBe('/management/backup/policies');
    expect(alert?.items).toHaveLength(4);
  });
});
