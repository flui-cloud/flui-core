import { SandboxSlotGateService } from './sandbox-slot-gate';
import { loadSandboxConfig } from '../sandbox.config';
import { SandboxTenantState } from '../entities/sandbox-tenant.entity';

type Area = {
  id: string;
  state: SandboxTenantState;
  clusterId: string;
  userId: string | null;
  projectId: string | null;
  namespace: string;
  createdAt: Date;
};

type Waiting = {
  id: string;
  userId: string;
  email: string | null;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  createdAt: Date;
};

const build = (
  areas: Area[],
  env: Record<string, string> = {},
  waiting: Waiting[] = [],
) => {
  const projectUpdates: Array<{ where: unknown; set: unknown }> = [];
  const matches = (a: Area, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object')
        return (a as Record<string, unknown>)[k] != null;
      return (a as Record<string, unknown>)[k] === v;
    });
  const tenants = {
    findOne: async ({ where }: { where: Record<string, unknown> }) =>
      areas.find((a) => matches(a, where)) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) =>
      areas.filter((a) => matches(a, where)).length,
    update: async (id: string, set: Partial<Area>) => {
      Object.assign(areas.find((a) => a.id === id)!, set);
    },
    createQueryBuilder: () => {
      let set: Partial<Area> = {};
      let params: { id: string; ready: SandboxTenantState } = {
        id: '',
        ready: SandboxTenantState.READY,
      };
      const qb = {
        update: () => qb,
        set: (s: Partial<Area>) => {
          set = s;
          return qb;
        },
        where: (_w: string, p: typeof params) => {
          params = p;
          return qb;
        },
        execute: async () => {
          const area = areas.find(
            (a) => a.id === params.id && a.state === params.ready,
          );
          if (!area) return { affected: 0 };
          Object.assign(area, set);
          return { affected: 1 };
        },
      };
      return qb;
    },
  };
  const projects = {
    update: async (where: unknown, set: unknown) => {
      projectUpdates.push({ where, set });
      return { affected: 1 };
    },
  };
  let seq = 0;
  const waitlist = {
    findOne: async ({ where }: { where: { userId: string } }) =>
      waiting.find((w) => w.userId === where.userId) ?? null,
    count: async ({
      where,
    }: {
      where: Record<string, { _value?: Date; _type?: string }>;
    }) => {
      if (where.offerExpiresAt) {
        const now = where.offerExpiresAt._value as Date;
        return waiting.filter((w) => w.offerExpiresAt && w.offerExpiresAt > now)
          .length;
      }
      const before = where.createdAt._value as Date;
      return waiting.filter((w) => w.createdAt < before).length;
    },
    create: (w: Partial<Waiting>) => w,
    save: async (w: Partial<Waiting>) => {
      const row = {
        id: `w${seq++}`,
        offeredAt: null,
        offerExpiresAt: null,
        createdAt: new Date(Date.now() + seq),
        email: null,
        ...w,
      } as Waiting;
      waiting.push(row);
      return row;
    },
    delete: async ({ userId }: { userId: string }) => {
      const at = waiting.findIndex((w) => w.userId === userId);
      if (at >= 0) waiting.splice(at, 1);
    },
  };
  const gate = new SandboxSlotGateService(
    tenants as never,
    projects as never,
    loadSandboxConfig({
      SANDBOX_ENABLED: 'true',
      SANDBOX_CLUSTER_ID: 'c1',
      SANDBOX_MAX_SLOTS: '2',
      ...env,
    }),
    waitlist as never,
  );
  return { gate, areas, projectUpdates, waiting };
};

const area = (over: Partial<Area>): Area => ({
  id: 'a',
  state: SandboxTenantState.READY,
  clusterId: 'c1',
  userId: null,
  projectId: 'p-a',
  namespace: 'p-area-a',
  createdAt: new Date(0),
  ...over,
});

describe('SandboxSlotGateService', () => {
  it('lets a guest who holds an area create on its cluster, and nowhere else', async () => {
    const { gate } = build([
      area({ state: SandboxTenantState.CLAIMED, userId: 'u1' }),
    ]);

    await expect(gate.assertCanCreate('u1', 'c1')).resolves.toBeUndefined();
    await expect(gate.assertCanCreate('u1', 'c2')).rejects.toMatchObject({
      response: { code: 'SANDBOX_CLUSTER_NOT_OWNED' },
    });
  });

  it('hands a ready area to a first deploy, and the project with it', async () => {
    const { gate, areas, projectUpdates } = build([area({})]);

    await gate.assertCanCreate('u1', 'c1', 'mario@example.com');

    expect(areas[0]).toMatchObject({
      state: SandboxTenantState.CLAIMED,
      userId: 'u1',
      email: 'mario@example.com',
    });
    expect(projectUpdates).toHaveLength(1);
    expect(projectUpdates[0].set).toEqual({ ownerUserId: 'u1' });
  });

  it('gives two first deploys two different areas', async () => {
    const { gate, areas } = build([
      area({ id: 'a', createdAt: new Date(0) }),
      area({ id: 'b', projectId: 'p-b', createdAt: new Date(1) }),
    ]);

    await gate.assertCanCreate('u1', 'c1');
    await gate.assertCanCreate('u2', 'c1');

    expect(areas.map((a) => a.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('refuses a first deploy when every slot is in use, and keeps the guest looking around', async () => {
    const { gate } = build([
      area({ id: 'x', state: SandboxTenantState.CLAIMED, userId: 'u8' }),
      area({ id: 'y', state: SandboxTenantState.CLAIMED, userId: 'u9' }),
      area({ id: 'z' }),
    ]);

    await expect(gate.assertCanCreate('u1', 'c1')).rejects.toMatchObject({
      response: { code: 'SANDBOX_FULL', statusCode: 503 },
    });
  });

  it('asks to come back in a minute when no area is ready yet', async () => {
    const { gate } = build([]);

    await expect(gate.assertCanCreate('u1', 'c1')).rejects.toMatchObject({
      response: { code: 'SANDBOX_BUILDING' },
    });
  });

  it('hands out nothing while the operator has closed the door', async () => {
    const { gate, areas } = build([area({})], {
      SANDBOX_ACCEPTING_CLAIMS: 'false',
    });

    await expect(gate.assertCanCreate('u1', 'c1')).rejects.toMatchObject({
      response: { code: 'SANDBOX_CLOSED' },
    });
    expect(areas[0].state).toBe(SandboxTenantState.READY);
  });

  it('lets a throwaway address look around but not take a space', async () => {
    const { gate, areas } = build([area({})]);

    await expect(
      gate.assertCanCreate('u1', 'c1', 'someone@mailinator.com'),
    ).rejects.toMatchObject({ response: { code: 'SANDBOX_EMAIL_REFUSED' } });
    expect(areas[0].state).toBe(SandboxTenantState.READY);

    await expect(
      gate.assertCanCreate('u2', 'c1', 'someone@example.com'),
    ).resolves.toBeUndefined();
  });

  it('never hands out an area on another cluster than the demo', async () => {
    const { gate } = build([area({})]);

    await expect(gate.assertCanCreate('u1', 'c9')).rejects.toMatchObject({
      response: { code: 'SANDBOX_CLUSTER_NOT_OWNED' },
    });
  });

  it('puts the area back when its project cannot be handed over', async () => {
    const { gate, areas } = build([area({})]);
    (
      gate as unknown as { projects: { update: () => Promise<never> } }
    ).projects.update = async () => {
      throw new Error('duplicate key value violates unique constraint');
    };

    await expect(gate.assertCanCreate('u1', 'c1')).rejects.toThrow(
      'duplicate key',
    );
    expect(areas[0]).toMatchObject({
      state: SandboxTenantState.READY,
      userId: null,
    });
  });
});

describe('SandboxSlotGateService and the waiting list', () => {
  const full = () => [
    area({ id: 'x', state: SandboxTenantState.CLAIMED, userId: 'u8' }),
    area({ id: 'y', state: SandboxTenantState.CLAIMED, userId: 'u9' }),
    area({ id: 'z' }),
  ];

  it('puts a guest who found every space taken on the list, and tells them where they stand', async () => {
    const { gate, waiting } = build(full());

    await expect(
      gate.assertCanCreate('u1', 'c1', 'mario@example.com'),
    ).rejects.toMatchObject({
      response: { code: 'SANDBOX_FULL', position: 1 },
    });
    await expect(gate.assertCanCreate('u2', 'c1')).rejects.toMatchObject({
      response: { position: 2 },
    });
    await expect(gate.assertCanCreate('u1', 'c1')).rejects.toMatchObject({
      response: { position: 1 },
    });

    expect(waiting.map((w) => w.userId)).toEqual(['u1', 'u2']);
  });

  it('lets the guest the space was offered to take it, and takes them off the list', async () => {
    const offered: Waiting = {
      id: 'w',
      userId: 'u1',
      email: null,
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(0),
    };
    const { gate, areas, waiting } = build(
      [
        area({ id: 'x', state: SandboxTenantState.CLAIMED, userId: 'u8' }),
        area({ id: 'z' }),
      ],
      {},
      [offered],
    );

    await gate.assertCanCreate('u1', 'c1');

    expect(areas.find((a) => a.id === 'z')?.userId).toBe('u1');
    expect(waiting).toHaveLength(0);
  });

  it('counts an outstanding offer as a taken space for everyone else', async () => {
    const offered: Waiting = {
      id: 'w',
      userId: 'u1',
      email: null,
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(0),
    };
    const { gate } = build(
      [
        area({ id: 'x', state: SandboxTenantState.CLAIMED, userId: 'u8' }),
        area({ id: 'z' }),
      ],
      {},
      [offered],
    );

    await expect(gate.assertCanCreate('u5', 'c1')).rejects.toMatchObject({
      response: { code: 'SANDBOX_FULL' },
    });
  });
});
