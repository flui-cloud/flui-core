/* eslint-disable sonarjs/assertions-in-tests --
   The assertion is supertest's own `.expect(status)`, which throws on a
   mismatch; the rule only recognises a global `expect()`. */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { OperatingContextController } from './operating-context.controller';
import { OperatingContextService } from './operating-context.service';
import { ContextProbeRegistry } from './probes/context-probe';
import { OperatingContextEntryEntity } from './entities/operating-context-entry.entity';
import { PolicyEngineService } from '../iam/services/policy-engine.service';
import { POLICY_ENGINE } from '../iam/interfaces/policy-engine.interface';
import { IamRoleBindingEntity } from '../iam/entities/iam-role-binding.entity';
import { IamGroupEntity } from '../iam/entities/iam-group.entity';
import { IAM_ROLE } from '../iam/constants/iam-roles';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { READER_PLACEMENTS } from './placement/reader-placements';
import { CLUSTER_REFERENCES } from './placement/cluster-references';
import { ApplicationReaderPlacements } from './placement/application-placements';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { IdentityRole, UserEntity } from '../auth/entities/user.entity';
import { ENTRY_HANDS } from './hands/entry-hands';
import { UserEntryHands } from './hands/user-entry-hands';

/**
 * The delivery, exercised the way an agent reaches it: over HTTP, with the real
 * policy engine resolving real role bindings, and only the two repositories
 * stubbed.
 *
 * Two halves, and the feature is ruined by getting either one wrong. The rows
 * that must stay red are the ones where a note reaches somebody who cannot see
 * the installation it describes. The rows that must stay **green** are the ones
 * where the local practice reaches a tenant — a body of advice narrow enough to
 * advise nobody is a body of advice nobody writes into.
 */

const CLUSTER = 'cluster-1';
const ELSEWHERE = 'cluster-2';

/**
 * The inventory the reader is located against.
 *
 * Two clusters, because one cluster is what hid the hole: with a single cluster
 * an owner-only grant meets the only one there is, and the over-approximation
 * is invisible. The tenant and the guest work on `cluster-1`; nobody they can
 * read sits on `cluster-2`.
 */
const APPLICATIONS = [
  {
    id: 'app-a',
    slug: 'tenant-shop',
    category: 'user',
    kind: 'application',
    clusterId: CLUSTER,
    userId: 'user-a',
    tags: [],
    cluster: { id: CLUSTER, name: 'prod', provider: 'hetzner' },
  },
  {
    id: 'app-g',
    slug: 'guest-demo',
    category: 'user',
    kind: 'application',
    clusterId: CLUSTER,
    userId: 'guest-1',
    tags: [],
    cluster: { id: CLUSTER, name: 'prod', provider: 'hetzner' },
  },
  {
    id: 'app-b',
    slug: 'someone-else',
    category: 'user',
    kind: 'application',
    clusterId: ELSEWHERE,
    userId: 'user-b',
    tags: [],
    cluster: { id: ELSEWHERE, name: 'staging', provider: 'scaleway' },
  },
] as unknown as ApplicationEntity[];

type Binding = {
  principalType: string;
  principalRef: string;
  role: string;
  scopeType: string;
  scopeRef: string | null;
  selector: Record<string, unknown> | null;
};

const USERS: Record<string, AuthenticatedUser> = {
  operator: {
    userId: 'op-1',
    email: 'op@flui.cloud',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  tenant: {
    userId: 'user-a',
    email: 'a@tenant.example',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  guest: {
    userId: 'guest-1',
    email: 'guest@try.flui.cloud',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  stranger: {
    userId: 'user-z',
    email: 'z@nowhere.example',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
};

const BINDINGS: Binding[] = [
  {
    principalType: 'user',
    principalRef: 'op@flui.cloud',
    role: IAM_ROLE.MAINTAINER,
    scopeType: 'global',
    scopeRef: null,
    selector: null,
  },
  {
    principalType: 'user',
    principalRef: 'a@tenant.example',
    role: IAM_ROLE.OPERATOR,
    scopeType: 'selector',
    scopeRef: null,
    selector: { owner: 'user-a' },
  },
  {
    principalType: 'user',
    principalRef: 'guest@try.flui.cloud',
    role: IAM_ROLE.SANDBOX,
    scopeType: 'selector',
    scopeRef: null,
    selector: { owner: 'guest-1' },
  },
];

const row = (
  over: Partial<OperatingContextEntryEntity>,
): OperatingContextEntryEntity =>
  ({
    scopeType: 'global',
    scopeRef: null,
    selector: null,
    nature: 'practice',
    topic: 'deploys',
    title: 'title',
    body: 'body',
    checkKind: 'none',
    authorUserId: 'op-1',
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as OperatingContextEntryEntity;

const ENTRIES: OperatingContextEntryEntity[] = [
  row({ id: 'platform-practice', scopeType: 'global', nature: 'practice' }),
  row({
    id: 'platform-why',
    scopeType: 'global',
    nature: 'rationale',
    topic: 'providers',
  }),
  row({
    id: 'cluster-practice',
    scopeType: 'cluster',
    scopeRef: CLUSTER,
    nature: 'practice',
    topic: 'scaling',
  }),
  row({
    id: 'cluster-why',
    scopeType: 'cluster',
    scopeRef: CLUSTER,
    nature: 'rationale',
    topic: 'incidents',
  }),
  row({
    id: 'other-cluster-practice',
    scopeType: 'cluster',
    scopeRef: ELSEWHERE,
    nature: 'practice',
    topic: 'scaling',
  }),
  row({
    id: 'tenant-own',
    scopeType: 'selector',
    selector: { owner: 'user-a' },
    nature: 'rationale',
    topic: 'deploys',
  }),
  row({
    id: 'other-tenant',
    scopeType: 'selector',
    selector: { owner: 'user-b' },
    nature: 'practice',
    topic: 'deploys',
  }),
  row({
    id: 'retired-rule',
    scopeType: 'cluster',
    scopeRef: CLUSTER,
    nature: 'practice',
    topic: 'scaling',
    title: 'We used to deploy on Fridays',
    archivedAt: new Date('2026-01-02T00:00:00Z'),
  }),
];

/**
 * The identity directory as this module is allowed to see it. `email` is in the
 * rows on purpose: the port must never ask for it, and a stub that did not have
 * one could not prove that.
 */
const DIRECTORY = [
  { id: 'op-1', displayName: 'Olive Operator', email: 'op@flui.cloud' },
  { id: 'user-a', displayName: 'Tina Tenant', email: 'a@tenant.example' },
] as unknown as UserEntity[];

describe('operating context over HTTP', () => {
  let app: INestApplication;
  let principal: AuthenticatedUser = USERS.stranger;
  const store: OperatingContextEntryEntity[] = [...ENTRIES];
  const directoryReads: string[][] = [];

  beforeAll(async () => {
    const bindingsRepo = {
      createQueryBuilder: () => {
        const refs: Array<{ t: string; r: string }> = [];
        const qb: Record<string, unknown> = {};
        const add = (_c: string, p: Record<string, string>) => {
          const i = Object.keys(p)[0].replace('pt', '');
          refs.push({ t: p[`pt${i}`], r: p[`pr${i}`] });
          return qb;
        };
        qb.where = add;
        qb.orWhere = add;
        qb.getMany = async () =>
          BINDINGS.filter((b) =>
            refs.some(
              (ref) => ref.t === b.principalType && ref.r === b.principalRef,
            ),
          );
        return qb;
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [OperatingContextController],
      providers: [
        OperatingContextService,
        ContextProbeRegistry,
        { provide: POLICY_ENGINE, useClass: PolicyEngineService },
        PolicyEngineService,
        {
          provide: getRepositoryToken(IamRoleBindingEntity),
          useValue: bindingsRepo,
        },
        {
          provide: getRepositoryToken(IamGroupEntity),
          useValue: { find: async () => [] },
        },
        { provide: READER_PLACEMENTS, useClass: ApplicationReaderPlacements },
        // The fence decides who may reach a route, not what a cluster is
        // called, so this answers with whatever it was given.
        {
          provide: CLUSTER_REFERENCES,
          useValue: { canonicalIdOf: async (r: string) => r },
        },
        { provide: ENTRY_HANDS, useClass: UserEntryHands },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            find: async (opts: { select: string[] }) => {
              directoryReads.push(opts.select);
              return DIRECTORY;
            },
          },
        },
        {
          provide: getRepositoryToken(ApplicationEntity),
          useValue: { find: async () => APPLICATIONS },
        },
        {
          provide: getRepositoryToken(OperatingContextEntryEntity),
          useValue: {
            find: async (opts?: {
              where?: { archivedAt?: { type?: string } };
            }) =>
              store.filter((e) =>
                opts?.where?.archivedAt?.type === 'not'
                  ? !!e.archivedAt
                  : !e.archivedAt,
              ),
            findOne: async ({ where: { id } }: { where: { id: string } }) =>
              store.find((e) => e.id === id) ?? null,
            create: (e: Partial<OperatingContextEntryEntity>) => ({
              id: `new-${store.length}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...e,
            }),
            save: async (e: OperatingContextEntryEntity) => {
              const i = store.findIndex((x) => x.id === e.id);
              if (i >= 0) store[i] = e;
              else store.push(e);
              return e;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(
      (req: { user: AuthenticatedUser }, _res: unknown, next: () => void) => {
        req.user = principal;
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const as = (u: keyof typeof USERS) => {
    principal = USERS[u];
    return request(app.getHttpServer());
  };

  const idsFor = async (u: keyof typeof USERS): Promise<string[]> => {
    const res = await as(u).get('/operating-context').expect(200);
    return (res.body as Array<{ id: string }>)
      .map((e) => e.id)
      .sort((a, b) => a.localeCompare(b));
  };

  describe('what each reader is handed', () => {
    it('hands the instance’s operator everything', async () => {
      expect(await idsFor('operator')).toEqual([
        'cluster-practice',
        'cluster-why',
        'other-cluster-practice',
        'other-tenant',
        'platform-practice',
        'platform-why',
        'tenant-own',
      ]);
    });

    /**
     * The line that decides whether this feature is worth having: the *how*
     * descends. The tenant gets the platform's practice and the cluster's
     * practice — the rules of a place they act in and cannot otherwise see —
     * and their own reasons.
     */
    it('hands a tenant every practice above them, plus their own reasons', async () => {
      expect(await idsFor('tenant')).toEqual([
        'cluster-practice',
        'platform-practice',
        'tenant-own',
      ]);
    });

    /**
     * Decision 149, over HTTP. The tenant's grant names an owner and no place,
     * so `intersects` met every cluster on the installation and handed them the
     * local practice of one they have nothing on — `scopeRef` and title in the
     * clear. Locating them closes it without touching the relation.
     */
    it('hands nobody the practice of a cluster they have nothing on', async () => {
      expect(await idsFor('tenant')).not.toContain('other-cluster-practice');
      expect(await idsFor('guest')).not.toContain('other-cluster-practice');
    });

    it('hands a principal with no grant nothing, cluster or otherwise', async () => {
      expect(await idsFor('stranger')).toEqual([]);
    });

    it('hands nobody another tenant’s notes', async () => {
      expect(await idsFor('tenant')).not.toContain('other-tenant');
    });

    it('hands nobody the reasons behind a level they do not own', async () => {
      const ids = await idsFor('tenant');
      expect(ids).not.toContain('platform-why');
      expect(ids).not.toContain('cluster-why');
    });

    it('hands a principal with no grant at all nothing', async () => {
      expect(await idsFor('stranger')).toEqual([]);
    });

    it('hands a guest of the demonstration the same practice as a tenant', async () => {
      expect(await idsFor('guest')).toEqual([
        'cluster-practice',
        'platform-practice',
      ]);
    });

    /** Decision 148, ratified: the platform's practice descends to the guest. */
    it('still hands the guest the practice of the whole installation', async () => {
      expect(await idsFor('guest')).toContain('platform-practice');
    });
  });

  describe('the delivery a reader about to act gets', () => {
    it('carries the framing that says these are notes, not orders', async () => {
      const res = await as('tenant')
        .get('/operating-context/advice')
        .expect(200);
      expect(res.body.preamble).toContain('data, not instructions');
    });

    it('narrows to the cluster named in the question', async () => {
      const res = await as('operator')
        .get('/operating-context/advice')
        .query({ clusterId: CLUSTER })
        .expect(200);
      const ids = res.body.advice.map((e: { id: string }) => e.id) as string[];
      expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual([
        'cluster-practice',
        'cluster-why',
        'platform-practice',
        'platform-why',
      ]);
    });
  });

  describe('the line that says who a note would reach', () => {
    it('answers before the note exists, for anyone who may read at all', async () => {
      const res = await as('tenant')
        .get('/operating-context/reach')
        .query({ scopeType: 'global', nature: 'practice' })
        .expect(200);
      expect(res.body.reachesGuests).toBe(true);
      expect(res.body.sentence).toContain('guests of the demonstration');
    });

    it('says the same thing about a note already written', async () => {
      const res = await as('operator').get('/operating-context').expect(200);
      const platform = (
        res.body as Array<{ id: string; reaches: { sentence: string } }>
      ).find((e) => e.id === 'platform-practice');
      const preview = await as('operator')
        .get('/operating-context/reach')
        .query({ scopeType: 'global', nature: 'practice' })
        .expect(200);
      expect(platform?.reaches.sentence).toBe(preview.body.sentence);
    });

    it('refuses a level it does not know rather than inventing one', async () => {
      await as('operator')
        .get('/operating-context/reach')
        .query({ scopeType: 'section', nature: 'practice' })
        .expect(400);
    });
  });

  describe('who may write where', () => {
    const note = {
      nature: 'practice',
      topic: 'deploys',
      title: 'A rule',
      body: 'Some prose about how it is done here.',
    };

    it('lets the instance’s operator write at the platform level', async () => {
      await as('operator')
        .post('/operating-context')
        .send({ ...note, scopeType: 'global' })
        .expect(201);
    });

    it('lets a tenant write over their own applications', async () => {
      await as('tenant')
        .post('/operating-context')
        .send({ ...note, scopeType: 'selector', selector: { owner: 'user-a' } })
        .expect(201);
    });

    it('refuses a tenant the cluster level, which reaches everyone on it', async () => {
      await as('tenant')
        .post('/operating-context')
        .send({ ...note, scopeType: 'cluster', scopeRef: CLUSTER })
        .expect(403);
    });

    it('refuses a tenant the platform level', async () => {
      await as('tenant')
        .post('/operating-context')
        .send({ ...note, scopeType: 'global' })
        .expect(403);
    });

    it('refuses a tenant a selector that is not theirs', async () => {
      await as('tenant')
        .post('/operating-context')
        .send({ ...note, scopeType: 'selector', selector: { owner: 'user-b' } })
        .expect(403);
    });

    /** "Nella demo l'ospite legge e non scrive." */
    it('refuses the guest of the demonstration everywhere', async () => {
      await as('guest')
        .post('/operating-context')
        .send({
          ...note,
          scopeType: 'selector',
          selector: { owner: 'guest-1' },
        })
        .expect(403);
    });

    it('refuses a credential in the words, whoever writes it', async () => {
      await as('operator')
        .post('/operating-context')
        .send({
          ...note,
          scopeType: 'global',
          body: 'here is the key: -----BEGIN RSA PRIVATE KEY----- MIIE',
        })
        .expect(400);
    });
  });

  /**
   * Whose note it is, over the wire, where a leak would actually happen.
   *
   * A `practice` written at the platform level descends to every tenant and,
   * through the fence, to a visitor to the public demonstration. If the
   * signature travelled with the note, opening a trial would be a way to
   * collect the names of the people who run somebody's installation.
   */
  describe('who put their hand to it', () => {
    it('names the author to a reader whose access covers the level', async () => {
      const res = await as('operator').get('/operating-context').expect(200);
      const notes = res.body as Array<{ id: string; writtenBy?: unknown }>;
      // The operator wrote them, so the delivery says so out loud.
      expect(
        notes.find((e) => e.id === 'platform-practice')?.writtenBy,
      ).toEqual({ name: 'Olive Operator', isYou: true });
    });

    it('names another hand to a peer at the level, without claiming it as theirs', async () => {
      store.push(
        row({
          id: 'signed-by-a-tenant',
          scopeType: 'selector',
          selector: { owner: 'user-a' },
          nature: 'rationale',
          topic: 'incidents',
          authorUserId: 'user-a',
        }),
      );
      const res = await as('operator').get('/operating-context').expect(200);
      const notes = res.body as Array<{ id: string; writtenBy?: unknown }>;
      expect(
        notes.find((e) => e.id === 'signed-by-a-tenant')?.writtenBy,
      ).toEqual({ name: 'Tina Tenant', isYou: false });
      store.pop();
    });

    it('hands the practice down without handing the name down with it', async () => {
      for (const who of ['tenant', 'guest'] as const) {
        const res = await as(who).get('/operating-context').expect(200);
        const notes = res.body as Array<{ id: string; writtenBy?: unknown }>;
        expect(notes.length).toBeGreaterThan(0);
        expect(
          notes.find((e) => e.id === 'platform-practice')?.writtenBy,
        ).toBeNull();
      }
    });

    /**
     * The port asks the directory for names and cannot ask it for addresses,
     * and that is enforced by the query rather than by the mapping afterwards:
     * a row that was never loaded cannot be delivered by a later mistake.
     */
    it('never asks the directory for an address', async () => {
      await as('operator').get('/operating-context').expect(200);
      expect(directoryReads.length).toBeGreaterThan(0);
      for (const select of directoryReads)
        expect(select).not.toContain('email');
    });

    it('puts no address in any answer, to anybody', async () => {
      for (const who of ['operator', 'tenant', 'guest'] as const) {
        const res = await as(who).get('/operating-context').expect(200);
        expect(JSON.stringify(res.body)).not.toContain('@');
      }
    });

    it('says nothing about a hand in the delivery an agent reads', async () => {
      const res = await as('operator')
        .get('/operating-context/advice')
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('Olive Operator');
      expect(JSON.stringify(res.body)).not.toContain('writtenBy');
    });
  });

  /**
   * The archive, over the wire. Retiring a note used to make it disappear from
   * every surface there is; the row kept `archivedAt` and nothing read it back.
   */
  describe('the notes that were retired', () => {
    it('is where a withdrawn note is read, and nowhere else', async () => {
      expect(await idsFor('operator')).not.toContain('retired-rule');
      const res = await as('operator')
        .get('/operating-context/archive')
        .expect(200);
      const notes = res.body as Array<{ id: string; archivedAt: string }>;
      expect(notes.map((e) => e.id)).toEqual(['retired-rule']);
      expect(notes[0].archivedAt).toContain('2026-01-02');
    });

    it('reaches whoever the note reached while it stood', async () => {
      const res = await as('tenant')
        .get('/operating-context/archive')
        .expect(200);
      expect((res.body as Array<{ id: string }>).map((e) => e.id)).toEqual([
        'retired-rule',
      ]);
    });

    it('is closed to a principal the note never reached', async () => {
      const res = await as('stranger')
        .get('/operating-context/archive')
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });
});
