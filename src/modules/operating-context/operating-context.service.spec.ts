import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OperatingContextService } from './operating-context.service';
import { ContextProbe, ContextProbeRegistry } from './probes/context-probe';
import { OperatingContextEntryEntity } from './entities/operating-context-entry.entity';
import { IamPrincipal, PrincipalAccess } from '../iam/interfaces/iam.types';
import { Placement } from './operating-context.core';
import { ReaderPlacements } from './placement/reader-placements';
import { EntryHands } from './hands/entry-hands';
import { IdentityRole } from '../auth/entities/user.entity';

const DAY = 24 * 60 * 60 * 1000;

/** The directory, as far as this module is allowed to see it: names, no addresses. */
const NAMES: Record<string, string> = {
  author: 'Ada Ops',
  u1: 'Tenant One',
  op: 'Olive Operator',
};

const principal = (userId: string): IamPrincipal => ({
  userId,
  email: `${userId}@flui.cloud`,
  role: IdentityRole.USER,
  isAdmin: false,
});

const tenantAccess = (owner: string): PrincipalAccess => ({
  isAdmin: false,
  globalPermissions: new Set<string>(),
  scopedGrants: [
    {
      permissions: new Set(['app:read', 'app:write']),
      scopeType: 'selector',
      scopeRef: null,
      selector: { owner },
    },
  ],
  isSandbox: false,
});

const operatorAccess = (): PrincipalAccess => ({
  isAdmin: false,
  globalPermissions: new Set(['app:read', 'app:write']),
  scopedGrants: [],
  isSandbox: false,
});

/**
 * A probe of the shape the platform ships: it says what type it answers in, and
 * refuses parameters it will not answer at all.
 */
const nodeCountProbe = (): ContextProbe => ({
  id: 'cluster.field',
  describes: 'a cluster’s nodeCount',
  answers: (p) => {
    if (p.field !== 'nodeCount') throw new Error('field not readable');
    return 'number';
  },
  run: async () => 3,
});

const entry = (
  over: Partial<OperatingContextEntryEntity>,
): OperatingContextEntryEntity =>
  ({
    id: over.id ?? 'e1',
    scopeType: 'global',
    scopeRef: null,
    selector: null,
    nature: 'practice',
    topic: 'deploys',
    title: 'A title',
    body: 'A body',
    checkKind: 'none',
    authorUserId: 'author',
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as OperatingContextEntryEntity;

function build(
  rows: OperatingContextEntryEntity[],
  access: PrincipalAccess,
  sits: Placement[] | null = null,
) {
  const store = [...rows];
  const repo = {
    find: jest.fn(
      async (opts?: { where?: { archivedAt?: { type?: string } } }) =>
        store.filter((e) =>
          opts?.where?.archivedAt?.type === 'not'
            ? !!e.archivedAt
            : !e.archivedAt,
        ),
    ),
    findOne: jest.fn(
      async ({ where: { id } }: { where: { id: string } }) =>
        store.find((e) => e.id === id) ?? null,
    ),
    create: (e: Partial<OperatingContextEntryEntity>) => ({
      id: 'new',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...e,
    }),
    save: jest.fn(async (e: OperatingContextEntryEntity) => {
      const i = store.findIndex((x) => x.id === e.id);
      if (i >= 0) store[i] = e;
      else store.push(e);
      return e;
    }),
  };
  const probes = new ContextProbeRegistry();
  const policy = {
    resolveAccess: jest.fn(async () => access),
  };
  const placements: ReaderPlacements = {
    placementsOf: jest.fn(async () => sits),
  };
  const hands: EntryHands = {
    namesOf: jest.fn(
      async (ids: string[]) =>
        new Map(
          ids
            .map((id) => [id, NAMES[id] ?? undefined])
            .filter((p): p is [string, string] => !!p[1]),
        ),
    ),
  };
  const service = new OperatingContextService(
    repo as never,
    policy as never,
    probes,
    placements,
    hands,
  );
  return { service, repo, probes, store, placements, hands };
}

describe('what a reader is handed', () => {
  const rows = [
    entry({
      id: 'platform',
      scopeType: 'global',
      nature: 'practice',
      topic: 'deploys',
    }),
    entry({
      id: 'why',
      scopeType: 'global',
      nature: 'rationale',
      topic: 'providers',
    }),
    entry({
      id: 'mine',
      scopeType: 'selector',
      selector: { owner: 'u1' },
      nature: 'rationale',
      topic: 'deploys',
    }),
    entry({
      id: 'theirs',
      scopeType: 'selector',
      selector: { owner: 'u2' },
      nature: 'practice',
      topic: 'deploys',
    }),
  ];

  it('gives a tenant the platform’s practice, their own reasons, and nothing else', async () => {
    const { service } = build(rows, tenantAccess('u1'));
    const got = await service.list(principal('u1'));
    expect(got.map((e) => e.id).sort((a, b) => a.localeCompare(b))).toEqual([
      'mine',
      'platform',
    ]);
  });

  it('gives an instance-wide operator all four', async () => {
    const { service } = build(rows, operatorAccess());
    expect(await service.list(principal('op'))).toHaveLength(4);
  });

  it('names the disagreement instead of picking a winner', async () => {
    const { service } = build(rows, tenantAccess('u1'));
    const delivery = await service.advice(principal('u1'));
    expect(delivery.conflicts).toEqual([
      {
        topic: 'deploys',
        entryIds: expect.arrayContaining(['platform', 'mine']),
      },
    ]);
  });

  it('narrows to what applies where the caller is about to act', async () => {
    const { service } = build(
      [
        entry({ id: 'c1', scopeType: 'cluster', scopeRef: 'c1' }),
        entry({ id: 'c2', scopeType: 'cluster', scopeRef: 'c2' }),
      ],
      operatorAccess(),
    );
    const got = await service.list(principal('op'), { clusterId: 'c1' });
    expect(got.map((e) => e.id)).toEqual(['c1']);
  });
});

describe('an entry whose premise failed stops advising', () => {
  const broken = entry({
    id: 'broken',
    scopeType: 'cluster',
    scopeRef: 'c1',
    checkKind: 'probe',
    probeId: 'p',
    probeOp: 'equals',
    probeExpected: 'master-1',
  });

  it('is withheld from the advice and named for review', async () => {
    const { service, probes } = build([broken], operatorAccess());
    probes.register({ id: 'p', describes: 'x', run: async () => 'worker-9' });
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice).toEqual([]);
    expect(delivery.needsReview.map((e) => e.id)).toEqual(['broken']);
  });

  it('advises again the moment the platform agrees', async () => {
    const { service, probes } = build([broken], operatorAccess());
    probes.register({ id: 'p', describes: 'x', run: async () => 'master-1' });
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice.map((e) => e.confidence)).toEqual(['checked']);
    expect(delivery.needsReview).toEqual([]);
  });

  it('keeps advising, marked, when the probe cannot answer at all', async () => {
    const { service } = build([broken], operatorAccess());
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice.map((e) => e.confidence)).toEqual(['unverified']);
  });

  it('records the moment the premise broke, and only then', async () => {
    const { service, probes, repo, store } = build([broken], operatorAccess());
    probes.register({ id: 'p', describes: 'x', run: async () => 'worker-9' });
    await service.advice(principal('op'));
    expect(store[0].lastProbeStatus).toBe('broken');
    const writes = repo.save.mock.calls.length;
    await service.advice(principal('op'));
    expect(repo.save.mock.calls).toHaveLength(writes);
  });

  it('lets a lapsed confirmation still advise, marked stale', async () => {
    const stale = entry({
      id: 'stale',
      checkKind: 'attestation',
      confirmedAt: new Date(Date.now() - 400 * DAY),
      validForDays: 30,
    });
    const { service } = build([stale], operatorAccess());
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice.map((e) => e.confidence)).toEqual(['stale']);
    expect(delivery.needsReview.map((e) => e.id)).toEqual(['stale']);
  });
});

describe('writing a note', () => {
  const good = {
    scopeType: 'selector' as const,
    selector: { owner: 'u1' },
    nature: 'practice' as const,
    topic: 'deploys',
    title: 'We deploy after 14:00',
    body: 'The EU customers are asleep and Support is on.',
  };

  it('lets a tenant write at a level their grant covers', async () => {
    const { service } = build([], tenantAccess('u1'));
    await expect(service.create(principal('u1'), good)).resolves.toMatchObject({
      topic: 'deploys',
      confidence: 'unverified',
    });
  });

  it('refuses a tenant the platform’s level', async () => {
    const { service } = build([], tenantAccess('u1'));
    await expect(
      service.create(principal('u1'), {
        ...good,
        scopeType: 'global',
        selector: undefined,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a tenant a level next door', async () => {
    const { service } = build([], tenantAccess('u1'));
    await expect(
      service.create(principal('u1'), { ...good, selector: { owner: 'u2' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /** Rule 4: a global note has nothing to be compared with. */
  it('refuses a probe on a global note', async () => {
    const { service } = build([], operatorAccess());
    await expect(
      service.create(principal('op'), {
        ...good,
        scopeType: 'global',
        selector: undefined,
        checkKind: 'probe',
        probeId: 'app.field',
        probeOp: 'equals',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the same probe one level down', async () => {
    const { service, probes } = build([], operatorAccess());
    probes.register(nodeCountProbe());
    await expect(
      service.create(principal('op'), {
        ...good,
        scopeType: 'cluster',
        scopeRef: 'c1',
        selector: undefined,
        checkKind: 'probe',
        probeId: 'cluster.field',
        probeParams: { clusterId: 'c1', field: 'nodeCount' },
        probeOp: 'atLeast',
        probeExpected: 3,
      }),
    ).resolves.toMatchObject({ checkedBy: 'probe' });
  });

  it('refuses a credential pasted into the words', async () => {
    const { service } = build([], tenantAccess('u1'));
    await expect(
      service.create(principal('u1'), {
        ...good,
        body: 'the deploy key is -----BEGIN OPENSSH PRIVATE KEY----- b3Blb',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an attestation with no shelf life', async () => {
    const { service } = build([], tenantAccess('u1'));
    await expect(
      service.create(principal('u1'), { ...good, checkKind: 'attestation' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('will not let a person sign away a premise the platform contradicted', async () => {
    const probed = entry({
      id: 'p1',
      scopeType: 'cluster',
      scopeRef: 'c1',
      checkKind: 'probe',
    });
    const { service } = build([probed], operatorAccess());
    await expect(service.confirm(principal('op'), 'p1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('archives rather than deletes', async () => {
    const { service, store } = build([entry({ id: 'e1' })], operatorAccess());
    await service.archive(principal('op'), 'e1');
    expect(store[0].archivedAt).toBeInstanceOf(Date);
  });

  it('refuses to reword a note at a level the caller does not cover', async () => {
    const { service } = build(
      [entry({ id: 'e1', scopeType: 'global' })],
      tenantAccess('u1'),
    );
    await expect(
      service.edit(principal('u1'), 'e1', { body: 'mine now' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * The same repair seen from the service, which is where the placements are
 * resolved. A tenant on one cluster of a two-cluster installation used to be
 * handed the local practice of the other one, `scopeRef` and title in the
 * clear, because their grant named only its owner.
 */
describe('a tenant on an installation with more than one cluster', () => {
  const rows = [
    entry({ id: 'here', scopeType: 'cluster', scopeRef: 'c1', topic: 'a' }),
    entry({
      id: 'elsewhere',
      scopeType: 'cluster',
      scopeRef: 'c2',
      topic: 'b',
    }),
    entry({ id: 'platform', scopeType: 'global', topic: 'c' }),
  ];

  it('is handed the practice of the cluster it is actually on, and no other', async () => {
    const { service } = build(rows, tenantAccess('u1'), [{ clusterId: 'c1' }]);
    const got = await service.list(principal('u1'));
    expect(got.map((e) => e.id).sort((a, b) => a.localeCompare(b))).toEqual([
      'here',
      'platform',
    ]);
  });

  it('is still handed the platform’s practice when it sits nowhere', async () => {
    const { service } = build(rows, tenantAccess('u1'), []);
    expect((await service.list(principal('u1'))).map((e) => e.id)).toEqual([
      'platform',
    ]);
  });

  it('is handed both again when nobody can say where it sits', async () => {
    const { service } = build(rows, tenantAccess('u1'), null);
    expect((await service.list(principal('u1'))).map((e) => e.id)).toEqual([
      'here',
      'elsewhere',
      'platform',
    ]);
  });

  it('widens back rather than narrowing when locating the reader throws', async () => {
    const { service, placements } = build(rows, tenantAccess('u1'), []);
    (placements.placementsOf as jest.Mock).mockRejectedValue(
      new Error('inventory down'),
    );
    expect((await service.list(principal('u1'))).map((e) => e.id)).toEqual([
      'here',
      'elsewhere',
      'platform',
    ]);
  });

  it('does not go looking for a reader it would answer without', async () => {
    const { service, placements } = build(rows, operatorAccess(), [
      { clusterId: 'c1' },
    ]);
    await service.list(principal('op'));
    expect(placements.placementsOf).not.toHaveBeenCalled();
  });

  it('does not go looking when nothing in front of the reader names a place', async () => {
    const { service, placements } = build(
      [entry({ id: 'platform', scopeType: 'global' })],
      tenantAccess('u1'),
      [{ clusterId: 'c1' }],
    );
    await service.list(principal('u1'));
    expect(placements.placementsOf).not.toHaveBeenCalled();
  });

  /**
   * The reasons are decided by `covers`, which already refuses a tenant a
   * cluster it merely has an application on — so locating the reader must not
   * become the thing that lets one through.
   */
  it('does not turn being on a cluster into reading its reasons', async () => {
    const { service } = build(
      [
        entry({
          id: 'why',
          scopeType: 'cluster',
          scopeRef: 'c1',
          nature: 'rationale',
        }),
      ],
      tenantAccess('u1'),
      [{ clusterId: 'c1' }],
    );
    expect(await service.list(principal('u1'))).toEqual([]);
  });
});

describe('the line that says who a note reaches', () => {
  it('rides along on a note read back', async () => {
    const { service } = build(
      [entry({ id: 'platform', scopeType: 'global', nature: 'practice' })],
      operatorAccess(),
    );
    const [got] = await service.list(principal('op'));
    expect(got.reaches).toMatchObject({
      audience: 'installation',
      reachesGuests: true,
    });
  });

  it('rides along on the note just written', async () => {
    const { service } = build([], operatorAccess());
    const made = await service.create(principal('op'), {
      scopeType: 'cluster',
      scopeRef: 'c1',
      nature: 'practice',
      topic: 'deploys',
      title: 'A rule',
      body: 'Some prose.',
    });
    expect(made.reaches?.sentence).toContain('cluster c1');
  });

  /** The agent's delivery is not the place for it — it costs context and asks
   *  a question the model was not put there to answer. */
  it('stays off the delivery an agent reads', async () => {
    const { service } = build([entry({ id: 'e1' })], operatorAccess());
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice[0]).not.toHaveProperty('reaches');
  });

  it('answers for a level that does not exist yet', () => {
    const { service } = build([], tenantAccess('u1'));
    expect(service.reachFor('global', 'practice').sentence).toContain(
      'every tenant',
    );
  });

  it('refuses a level or a nature it does not know', () => {
    const { service } = build([], tenantAccess('u1'));
    expect(() => service.reachFor('project', 'practice')).toThrow(
      BadRequestException,
    );
    expect(() => service.reachFor('global', 'gossip')).toThrow(
      BadRequestException,
    );
    expect(() => service.reachFor('cluster', 'practice')).toThrow(
      BadRequestException,
    );
  });
});

describe('what a note is written on, in the delivery', () => {
  const pinned = entry({
    id: 'theirs',
    scopeType: 'selector',
    selector: { owner: 'u2', kind: 'postgres' },
    nature: 'practice',
    topic: 'backups',
  });

  it('rides along on a note read back over HTTP', async () => {
    const { service } = build([pinned], operatorAccess());
    const [got] = await service.list(principal('op'));
    expect(got.selector).toEqual({ owner: 'u2', kind: 'postgres' });
  });

  it('is null for a level that already says the whole of itself', async () => {
    const { service } = build(
      [entry({ id: 'c', scopeType: 'cluster', scopeRef: 'c1' })],
      operatorAccess(),
    );
    const [got] = await service.list(principal('op'));
    expect(got.selector).toBeNull();
  });

  /**
   * The whole point of the field: without it a selector note tells an agent
   * that it reaches them and not what it is about, so "this rule applies to
   * what you are touching" was a claim nobody had checked.
   */
  it('reaches the agent too, so a note can say what it covers', async () => {
    const { service } = build([pinned], operatorAccess());
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice[0].selector).toEqual({ kind: 'postgres' });
  });

  /**
   * A grant that follows a kind and names no place meets a note written on
   * somebody else's resources — `intersects` discards an axis only when both
   * sides declare it. The note is theirs to read; the user id behind it is not.
   */
  it('does not tell an agent which principal a note follows', async () => {
    const byKind: PrincipalAccess = {
      isAdmin: false,
      globalPermissions: new Set<string>(),
      scopedGrants: [
        {
          permissions: new Set(['app:read']),
          scopeType: 'selector',
          scopeRef: null,
          selector: { kind: 'postgres' },
        },
      ],
      isSandbox: false,
    };
    const { service } = build([pinned], byKind);

    const [overHttp] = await service.list(principal('u3'));
    expect(overHttp.selector).toEqual({ owner: 'u2', kind: 'postgres' });

    const delivery = await service.advice(principal('u3'));
    expect(delivery.advice).toHaveLength(1);
    expect(JSON.stringify(delivery.advice)).not.toContain('u2');
    expect(delivery.advice[0].pinnedToAnOwner).toBe(true);
  });

  it('says nothing about an owner when there is none to withhold', async () => {
    const { service } = build(
      [entry({ id: 'k', scopeType: 'selector', selector: { kind: 'redis' } })],
      operatorAccess(),
    );
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice[0].pinnedToAnOwner).toBe(false);
  });
});

/**
 * Decision 166, at the layer the correction belongs to.
 *
 * The dashboard had already solved this for its own form. MCP, the CLI and a
 * direct call had not, and they write the same premise — so the fix is at the
 * moment of writing, once, for every writer there will ever be.
 */
describe('a premise written down through the API', () => {
  const nodes = {
    scopeType: 'cluster' as const,
    scopeRef: 'c1',
    nature: 'practice' as const,
    topic: 'scaling',
    title: 'We keep three nodes',
    body: 'Two is not enough to drain one for maintenance.',
    checkKind: 'probe' as const,
    probeId: 'cluster.field',
    probeParams: { clusterId: 'c1', field: 'nodeCount' },
    probeOp: 'equals' as const,
  };

  it('does not let a note posted as text declare itself broken', async () => {
    const { service, probes, store } = build([], operatorAccess());
    probes.register(nodeCountProbe());
    const written = await service.create(principal('op'), {
      ...nodes,
      probeExpected: '3',
    });
    expect(store[0].probeExpected).toBe(3);
    expect(written.confidence).toBe('checked');
  });

  it('refuses a premise it cannot read, rather than saving one that will accuse itself', async () => {
    const { service, probes, store } = build([], operatorAccess());
    probes.register(nodeCountProbe());
    await expect(
      service.create(principal('op'), {
        ...nodes,
        probeExpected: 'about three',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store).toEqual([]);
  });

  it('refuses a note leaning on a fact this installation does not offer', async () => {
    const { service } = build([], operatorAccess());
    await expect(
      service.create(principal('op'), { ...nodes, probeExpected: 3 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves a note with no premise to interpret alone', async () => {
    const { service, store } = build([], operatorAccess());
    await service.create(principal('op'), {
      scopeType: 'global',
      nature: 'practice',
      topic: 'deploys',
      title: 'We deploy after 14:00',
      body: 'The EU customers are asleep and Support is on.',
    });
    expect(store[0].probeExpected).toBeNull();
  });
});

/**
 * Whose note it is.
 *
 * A rule with nobody's name on it cannot be discussed or updated — there is no
 * one to ask. But a signature is a fact about a **person** riding on a note
 * that travels very widely, so it is given the reach of a `rationale` and not
 * of the note: whoever covers the level is a peer there and is told; everybody
 * further down is told what is done and, correctly, that it is the level's.
 */
describe('who wrote a note', () => {
  const theirs = entry({
    id: 'platform',
    scopeType: 'global',
    nature: 'practice',
    authorUserId: 'author',
  });

  it('tells a reader who covers the level, by name and never by address', async () => {
    const { service } = build([theirs], operatorAccess());
    const [note] = await service.list(principal('op'));
    expect(note.writtenBy).toEqual({ name: 'Ada Ops', isYou: false });
    expect(JSON.stringify(note)).not.toContain('@');
  });

  it('hands the practice to a tenant without handing over whose it is', async () => {
    const platformPractice = entry({
      id: 'platform',
      scopeType: 'global',
      nature: 'practice',
      authorUserId: 'author',
    });
    const { service, hands } = build([platformPractice], tenantAccess('u1'));
    const [note] = await service.list(principal('u1'));
    expect(note.id).toBe('platform');
    expect(note.writtenBy).toBeNull();
    expect(hands.namesOf).toHaveBeenCalledWith([]);
  });

  it('never tells a visitor to the demonstration', async () => {
    const guest: PrincipalAccess = {
      ...operatorAccess(),
      isSandbox: true,
    };
    const { service } = build([theirs], guest);
    const [note] = await service.list(principal('guest-1'));
    expect(note.writtenBy).toBeNull();
  });

  it('always shows you your own hand', async () => {
    const mine = entry({
      id: 'mine',
      scopeType: 'selector',
      selector: { owner: 'u1' },
      nature: 'rationale',
      authorUserId: 'u1',
    });
    const { service } = build([mine], tenantAccess('u1'));
    const [note] = await service.list(principal('u1'));
    expect(note.writtenBy).toEqual({ name: 'Tenant One', isYou: true });
  });

  it('says the note is signed by somebody with no name recorded', async () => {
    const unnamed = entry({ id: 'u', authorUserId: 'nameless' });
    const { service } = build([unnamed], operatorAccess());
    const [note] = await service.list(principal('op'));
    expect(note.writtenBy).toEqual({ name: null, isYou: false });
  });

  it('names who last put their hand to an attested note', async () => {
    const attested = entry({
      id: 'a',
      checkKind: 'attestation',
      validForDays: 30,
      confirmedAt: new Date(),
      confirmedByUserId: 'u1',
      authorUserId: 'author',
    });
    const { service } = build([attested], operatorAccess());
    const [note] = await service.list(principal('op'));
    expect(note.confirmedBy).toEqual({ name: 'Tenant One', isYou: false });
  });

  it('leaves the confirmer empty until somebody confirms', async () => {
    const { service } = build([theirs], operatorAccess());
    const [note] = await service.list(principal('op'));
    expect(note.confirmedBy).toBeNull();
  });

  /**
   * Decision 160 applied once more: `owner` is withheld from a model because it
   * names a person, and so is this. An agent cannot go and ask Ada, so the name
   * buys it nothing and costs a person's identity in a context that is logged,
   * replayed and quoted back.
   */
  it('never tells an agent whose note it is', async () => {
    const { service } = build([theirs], operatorAccess());
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice).toHaveLength(1);
    expect(JSON.stringify(delivery)).not.toContain('Ada Ops');
    expect(
      Object.keys(delivery.advice[0] as Record<string, unknown>),
    ).not.toContain('writtenBy');
  });

  it('signs a note the moment it is written, to the person who wrote it', async () => {
    const { service } = build([], tenantAccess('u1'));
    const written = await service.create(principal('u1'), {
      scopeType: 'selector',
      selector: { owner: 'u1' },
      nature: 'practice',
      topic: 'deploys',
      title: 'We deploy after 14:00',
      body: 'The EU customers are asleep and Support is on.',
    });
    expect(written.writtenBy).toEqual({ name: 'Tenant One', isYou: true });
  });
});

/**
 * The archive.
 *
 * `DELETE` archives rather than deletes, and nothing ever read `archivedAt`
 * back: retiring a note made it vanish, which is deletion with more steps and a
 * false promise of history.
 */
describe('a note that was retired', () => {
  const retired = entry({
    id: 'old',
    scopeType: 'global',
    nature: 'practice',
    topic: 'deploys',
    title: 'We used to deploy on Fridays',
    archivedAt: new Date('2026-01-02T00:00:00Z'),
  });

  it('is readable, with the day it was withdrawn', async () => {
    const { service } = build([retired], operatorAccess());
    const got = await service.retired(principal('op'));
    expect(got.map((e) => e.id)).toEqual(['old']);
    expect(got[0].archivedAt).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it('is not in the list and cannot reach an agent', async () => {
    const { service } = build([retired], operatorAccess());
    expect(await service.list(principal('op'))).toEqual([]);
    const delivery = await service.advice(principal('op'));
    expect(delivery.advice).toEqual([]);
    expect(delivery.needsReview).toEqual([]);
  });

  it('reaches exactly the readers it reached while it stood', async () => {
    const theirsRetired = entry({
      id: 'theirs',
      scopeType: 'selector',
      selector: { owner: 'u2' },
      nature: 'rationale',
      archivedAt: new Date(),
    });
    const { service } = build([retired, theirsRetired], tenantAccess('u1'));
    const got = await service.retired(principal('u1'));
    expect(got.map((e) => e.id)).toEqual(['old']);
  });

  /**
   * What was believed when it was withdrawn, not what would be believed now: a
   * retired note is a record, and re-litigating it against a world that has
   * moved on is how a record stops being one.
   */
  it('does not re-ask a premise that is no longer in force', async () => {
    const withPremise = entry({
      id: 'p',
      scopeType: 'cluster',
      scopeRef: 'c1',
      checkKind: 'probe',
      probeId: 'p',
      probeOp: 'equals',
      probeExpected: 'master-1',
      lastProbeStatus: 'holds',
      archivedAt: new Date(),
    });
    const { service, probes, repo } = build([withPremise], operatorAccess());
    const asked = jest.fn(async () => 'worker-9');
    probes.register({ id: 'p', describes: 'x', run: asked });
    const [note] = await service.retired(principal('op'));
    expect(asked).not.toHaveBeenCalled();
    expect(note.confidence).toBe('checked');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('is still narrowed by what the reader is about to act on', async () => {
    const elsewhere = entry({
      id: 'elsewhere',
      scopeType: 'cluster',
      scopeRef: 'c2',
      archivedAt: new Date(),
    });
    const { service } = build([retired, elsewhere], operatorAccess());
    const got = await service.retired(principal('op'), { clusterId: 'c1' });
    expect(got.map((e) => e.id)).toEqual(['old']);
  });
});

/**
 * The catalogue.
 *
 * Until it said what each probe wants, a screen offering a free key/value
 * editor could not know that `app.field` wants a `slug` — and the write refuses
 * without one. That is a refusal the author could not have avoided, which is
 * the same defect as a note that accuses itself: found out after pressing save,
 * either way.
 */
describe('what an author is told they may lean on', () => {
  const catalogued = (): ContextProbe => {
    const takes = [
      { name: 'slug', required: true },
      { name: 'field', required: true, oneOf: ['status', 'replicas'] },
    ];
    return {
      id: 'app.field',
      describes: 'One readable field of an application.',
      takes,
      answers: (p) => (p.field === 'replicas' ? 'number' : 'string'),
      run: async () => 'running',
    };
  };

  it('names the parameters each probe wants, and which it will not go without', () => {
    const { service, probes } = build([], operatorAccess());
    probes.register(catalogued());
    expect(service.probeCatalog()).toEqual([
      expect.objectContaining({
        id: 'app.field',
        takes: [
          { name: 'slug', required: true },
          { name: 'field', required: true, oneOf: ['status', 'replicas'] },
        ],
      }),
    ]);
  });

  /**
   * Which decides how the premise is read, and therefore whether the write is
   * refused: `replicas equals "2"` is stored as the number 2, and `status
   * atLeast …` can never hold whatever is written beside it.
   */
  it('says what type each accepted value answers in', () => {
    const { service, probes } = build([], operatorAccess());
    probes.register(catalogued());
    expect(service.probeCatalog()[0].answersPer).toEqual({
      param: 'field',
      types: { status: 'string', replicas: 'number' },
    });
  });

  it('publishes nothing a premise is not composed of', () => {
    const { service, probes } = build([], operatorAccess());
    probes.register(catalogued());
    for (const card of service.probeCatalog()) {
      expect(Object.keys(card).sort()).toEqual(
        ['answersPer', 'describes', 'id', 'takes'].filter((k) => k in card),
      );
    }
  });

  it('leaves a probe that never declared its parameters undeclared', () => {
    const { service, probes } = build([], operatorAccess());
    probes.register({
      id: 'other',
      describes: 'elsewhere',
      run: async () => 1,
    });
    expect(service.probeCatalog()[0].takes).toBeUndefined();
  });
});

/**
 * Who withdrew it.
 *
 * The archive could be read back and not attributed: a retired rule said who
 * had written it and nothing about who decided it had stopped being true —
 * which is the person to ask before writing it again, and the reason somebody
 * opens the archive at all.
 */
describe('who retired a note', () => {
  const live = () =>
    entry({ id: 'old', scopeType: 'global', nature: 'practice' });

  it('records the hand that withdrew it', async () => {
    const { service, store } = build([live()], operatorAccess());
    await service.archive(principal('op'), 'old');
    expect(store[0].archivedByUserId).toBe('op');
  });

  it('names them to a reader who covers the level, and never by id', async () => {
    const { service } = build([live()], operatorAccess());
    await service.archive(principal('op'), 'old');
    const [note] = await service.retired(principal('op'));
    expect(note.archivedBy).toEqual({ name: 'Olive Operator', isYou: true });
    expect(JSON.stringify(note)).not.toContain('"op"');
  });

  /**
   * The same gate as the other two hands, and not a second one: a practice
   * descends to every tenant and to the guests of the public demonstration, so
   * a name riding on it would publish who runs the installation to anybody who
   * opened a trial.
   */
  it('says nothing to a reader the level does not cover', async () => {
    const platform = entry({
      id: 'old',
      scopeType: 'global',
      nature: 'practice',
      archivedAt: new Date(),
      archivedByUserId: 'op',
    });
    const { service } = build([platform], tenantAccess('u1'));
    const [note] = await service.retired(principal('u1'));
    expect(note.archivedBy).toBeNull();
    expect(JSON.stringify(note)).not.toContain('Olive Operator');
  });

  it('is null on a note nobody has withdrawn', async () => {
    const { service } = build([live()], operatorAccess());
    const [note] = await service.list(principal('op'));
    expect(note.archivedBy).toBeNull();
  });

  /** A retired note reaches no agent at all; this pins the field too. */
  it('is never delivered to an agent', async () => {
    const { service } = build([live()], operatorAccess());
    const delivery = await service.advice(principal('op'));
    expect(
      Object.keys(delivery.advice[0] as Record<string, unknown>),
    ).not.toContain('archivedBy');
  });
});
