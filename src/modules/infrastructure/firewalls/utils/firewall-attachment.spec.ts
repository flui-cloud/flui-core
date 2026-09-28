import { attachmentOf, serverIdOf } from './firewall-attachment';

describe('firewall attachment', () => {
  it('matches nodes to the servers the provider says the firewall covers', () => {
    const { attached, missing } = attachmentOf(
      [
        { id: 'master', providerResourceId: '111' },
        { id: 'worker', providerResourceId: 'fr-par-1:abc' },
        { id: 'new', providerResourceId: 'fr-par-1:def' },
      ],
      ['111', 'abc'],
    );
    expect(attached.map((n) => n.id)).toEqual(['master', 'worker']);
    expect(missing.map((n) => n.id)).toEqual(['new']);
  });

  it('counts a node without a server id as not covered', () => {
    expect(
      attachmentOf([{ id: 'n', providerResourceId: null }], ['1']).missing,
    ).toHaveLength(1);
    expect(serverIdOf({ id: 'n' })).toBeNull();
  });
});
