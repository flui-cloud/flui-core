import { AvailabilityInput, appAvailability } from './app-availability.core';

const ready: AvailabilityInput = {
  desiredCopies: 2,
  readyCopyNodes: ['wc-master', 'wc-worker-1'],
  ingressNodeCount: 2,
  dedicated: false,
  volumes: [{ name: 'uploads', boundToNode: null }],
  endpoints: [{ fqdn: 'shop.example.com', ipHostname: false }],
};

const codes = (input: Partial<AvailabilityInput>) =>
  appAvailability({ ...ready, ...input }).reasons.map((r) => r.code);

describe('whether an application survives losing a worker', () => {
  it('is highly available with two copies on two nodes, a domain and shared storage', () => {
    expect(appAvailability(ready)).toEqual({
      highlyAvailable: true,
      reasons: [],
    });
  });

  it('says one copy is not enough', () => {
    expect(
      codes({ desiredCopies: 1, readyCopyNodes: ['wc-master'] }),
    ).toContain('single_copy');
  });

  it('names the node all copies ended up on', () => {
    const result = appAvailability({
      ...ready,
      readyCopyNodes: ['wc-master', 'wc-master'],
    });
    expect(result.reasons).toEqual([
      expect.objectContaining({
        code: 'copies_on_one_node',
        message: expect.stringContaining('wc-master'),
      }),
    ]);
  });

  it('names a volume that stays on one node', () => {
    expect(
      codes({ volumes: [{ name: 'uploads', boundToNode: 'wc-master' }] }),
    ).toEqual(['volume_on_one_node']);
  });

  it('asks for a domain instead of a nip.io address', () => {
    expect(
      codes({
        endpoints: [{ fqdn: 'shop.1-2-3-4.nip.io', ipHostname: true }],
      }),
    ).toEqual(['ip_hostname']);
  });

  it('says when only one node takes traffic', () => {
    expect(codes({ ingressNodeCount: 1 })).toEqual(['single_ingress_node']);
  });

  it('does not ask an application without public addresses for traffic it does not take', () => {
    expect(codes({ endpoints: [], ingressNodeCount: 1 })).toEqual([]);
  });

  it('reports a dedicated application once, not also as copies on one node', () => {
    expect(
      codes({
        dedicated: true,
        readyCopyNodes: ['wc-worker-1', 'wc-worker-1'],
      }),
    ).toEqual(['dedicated_placement']);
  });
});
