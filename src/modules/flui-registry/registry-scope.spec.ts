import { grantRegistryAccess, parseRegistryScopes } from './registry-scope';

const MINE = 'apps/11111111-1111-4111-8111-111111111111';
const THEIRS = 'apps/22222222-2222-4222-8222-222222222222';

describe('what a registry credential is granted', () => {
  it('grants the actions asked for on its own repository', () => {
    expect(
      grantRegistryAccess(parseRegistryScopes(`repository:${MINE}:pull,push`), {
        name: MINE,
        actions: ['pull', 'push'],
      }),
    ).toEqual([{ type: 'repository', name: MINE, actions: ['pull', 'push'] }]);
  });

  it('never grants another repository, whatever is asked', () => {
    expect(
      grantRegistryAccess(
        parseRegistryScopes([
          `repository:${THEIRS}:pull,push`,
          'repository:*:pull',
          `repository:${MINE}/../${THEIRS}:pull`,
          'registry:catalog:*',
        ]),
        { name: MINE, actions: ['pull', 'push'] },
      ),
    ).toEqual([]);
  });

  it('narrows to what the credential holds: a pull credential cannot push', () => {
    expect(
      grantRegistryAccess(
        parseRegistryScopes(`repository:${MINE}:pull,push,delete`),
        {
          name: MINE,
          actions: ['pull'],
        },
      ),
    ).toEqual([{ type: 'repository', name: MINE, actions: ['pull'] }]);
  });

  it('answers docker login, which asks for nothing, with nothing', () => {
    expect(
      grantRegistryAccess(parseRegistryScopes(undefined), {
        name: MINE,
        actions: ['pull'],
      }),
    ).toEqual([]);
  });

  it('reads the space-separated form of the password grant and a name with a port-like colon', () => {
    expect(
      parseRegistryScopes(`repository:${MINE}:pull repository:a/b:c:push`),
    ).toEqual([
      { type: 'repository', name: MINE, actions: ['pull'] },
      { type: 'repository', name: 'a/b:c', actions: ['push'] },
    ]);
  });
});
