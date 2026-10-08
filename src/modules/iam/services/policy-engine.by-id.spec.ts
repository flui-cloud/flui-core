import { PolicyEngineService } from './policy-engine.service';
import { IdentityRole } from '../../auth/entities/user.entity';

describe('PolicyEngineService finds a person by id as well as by email', () => {
  const lookups = () => {
    const params: Array<Record<string, string>> = [];
    const qb: Record<string, unknown> = {};
    qb.where = (_c: string, p: Record<string, string>) => {
      params.push(p);
      return qb;
    };
    qb.orWhere = qb.where;
    qb.getMany = async () => [];
    const engine = new PolicyEngineService(
      { createQueryBuilder: () => qb } as never,
      { find: async () => [] } as never,
    );
    return { engine, params };
  };

  it('asks for grants written to the email and to the local id', async () => {
    const { engine, params } = lookups();

    await engine.check(
      {
        userId: '5b8d8a6c-0000-4000-8000-000000000001',
        email: 'mario@example.com',
        role: IdentityRole.USER,
        isAdmin: false,
      },
      'app:read',
    );

    const refs = params.map((p) => Object.values(p).join(':'));
    expect(refs).toContain('user:mario@example.com');
    expect(refs).toContain('user:5b8d8a6c-0000-4000-8000-000000000001');
  });
});
