import {
  ACCESS_MEMO_TTL_MS,
  PolicyEngineService,
} from './policy-engine.service';
import { IamPrincipal } from '../interfaces/iam.types';
import { IdentityRole } from '../../auth/entities/user.entity';

type Row = {
  principalType: string;
  principalRef: string;
  role: string;
  scopeType: string;
};

function makeEngine(rows: Row[]) {
  const getMany = jest.fn(async () => rows);
  const find = jest.fn(async () => []);
  const engine = new PolicyEngineService(
    {
      createQueryBuilder: () => {
        const qb: Record<string, unknown> = {};
        qb.where = () => qb;
        qb.orWhere = () => qb;
        qb.getMany = getMany;
        return qb;
      },
    } as never,
    { find } as never,
  );
  return { engine, getMany, find };
}

const principal = (over: Partial<IamPrincipal> = {}): IamPrincipal => ({
  userId: 'u-1',
  email: 'one@acme.com',
  role: IdentityRole.READONLY,
  isAdmin: false,
  ...over,
});

const editorRow: Row = {
  principalType: 'user',
  principalRef: 'one@acme.com',
  role: 'editor',
  scopeType: 'global',
};

describe('PolicyEngineService access memo', () => {
  afterEach(() => jest.useRealTimers());

  it('resolves a principal once for every guard of the same request', async () => {
    const { engine, getMany, find } = makeEngine([editorRow]);
    const [a, b] = await Promise.all([
      engine.resolveAccess(principal()),
      engine.resolveAccess(principal()),
    ]);
    await engine.check(principal(), 'app:read');
    expect(a).toBe(b);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('reads again once the TTL has passed', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { engine, getMany } = makeEngine([editorRow]);
    await engine.resolveAccess(principal());
    jest.setSystemTime(1_000_000 + ACCESS_MEMO_TTL_MS + 1);
    await engine.resolveAccess(principal());
    expect(getMany).toHaveBeenCalledTimes(2);
  });

  it('never shares an access between different users', async () => {
    const { engine, getMany } = makeEngine([editorRow]);
    await engine.resolveAccess(principal());
    await engine.resolveAccess(
      principal({ userId: 'u-2', email: 'two@acme.com' }),
    );
    await engine.resolveAccess(principal({ email: 'other@acme.com' }));
    expect(getMany).toHaveBeenCalledTimes(3);
  });

  it('keys on the identity provider roles the token carries', async () => {
    const { engine, getMany } = makeEngine([]);
    const plain = await engine.resolveAccess(principal());
    const owner = await engine.resolveAccess(
      principal({ roles: { owner: {} } }),
    );
    expect(getMany).toHaveBeenCalledTimes(2);
    expect(plain).not.toBe(owner);
  });

  it('forgets everything when a grant is written', async () => {
    const { engine, getMany } = makeEngine([editorRow]);
    await engine.resolveAccess(principal());
    engine.invalidateAccessCache();
    await engine.resolveAccess(principal());
    expect(getMany).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read', async () => {
    const { engine, getMany } = makeEngine([editorRow]);
    getMany.mockRejectedValueOnce(new Error('db down'));
    await expect(engine.resolveAccess(principal())).rejects.toThrow('db down');
    await expect(engine.resolveAccess(principal())).resolves.toBeDefined();
    expect(getMany).toHaveBeenCalledTimes(2);
  });
});
