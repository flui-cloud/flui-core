import { readOwnership } from './ownership';

describe('telling a resource Flui made from one the customer already had', () => {
  it('reads the ownership label the product writes on everything it creates', () => {
    const mark = readOwnership({
      kind: 'server',
      name: 'flui-abc-master',
      labels: {
        'managed-by': 'flui-cloud',
        'flui-cluster-id': '11111111-2222-3333-4444-555555555555',
      },
    });
    expect(mark).toEqual({
      owned: true,
      evidence: 'label',
      clusterId: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('does not accept a lookalike label value', () => {
    expect(
      readOwnership({
        kind: 'server',
        name: 'flui-abc-master',
        labels: { 'managed-by': 'flui' },
      }).owned,
    ).toBe(false);
  });

  /**
   * Scaleway IAM SSH keys take no tags at all — `createSSHKey` in flui-core
   * accepts the argument "for interface compliance" and drops it. So the only
   * mark a bootstrap key carries there is the name this CLI minted, and that
   * name embeds the cluster UUID.
   */
  it('recognises the bootstrap key name on a provider that has no tags', () => {
    const mark = readOwnership({
      kind: 'ssh-key',
      name: 'flui-bootstrap-11111111-2222-3333-4444-555555555555-flui-abc-master',
      labels: {},
    });
    expect(mark).toEqual({
      owned: true,
      evidence: 'minted-name',
      clusterId: '11111111-2222-3333-4444-555555555555',
    });
  });

  it.each([
    ['flui-bootstrap-not-a-uuid-master', 'no UUID in it'],
    ['my-flui-bootstrap-11111111-2222-3333-4444-555555555555-x', 'a prefix'],
    ['flui-bootstrap-11111111-2222-3333-4444-555555555555', 'no node suffix'],
  ])('refuses the name %s (%s)', (name) => {
    expect(readOwnership({ kind: 'ssh-key', name, labels: {} }).owned).toBe(
      false,
    );
  });

  it('never accepts a minted-looking name on a kind that is not a key', () => {
    expect(
      readOwnership({
        kind: 'server',
        name: 'flui-bootstrap-11111111-2222-3333-4444-555555555555-master',
        labels: {},
      }).owned,
    ).toBe(false);
  });
});
