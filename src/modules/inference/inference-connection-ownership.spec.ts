jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { InferenceResolverService } from './services/inference-resolver.service';
import { InferenceConnectionService } from './services/inference-connection.service';
import { InferenceConnectionEntity } from './entities/inference-connection.entity';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../auth/entities/user.entity';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';

/**
 * Decisions 104 and 124, and they are one test file because they are one
 * change: a connection gets an owner, and the owner is asked about *where the
 * key is spent* rather than where the list is drawn.
 *
 * The distinction is the whole point. A guard on the list and the delete would
 * have covered none of the ten places that turn a `connectionId` from a request
 * body into a live API key — the assistant's chat and agent turns and the eight
 * console assistants — because none of them reads the list. So the assertions
 * below come in two halves that have to be read together: the ones that prove a
 * stranger's row is unreachable, and the ones that prove the installation's row
 * is still reachable by everybody, which is what it has always been and the
 * common case today.
 */

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';

function row(
  over: Partial<InferenceConnectionEntity>,
): InferenceConnectionEntity {
  return {
    id: 'row-1',
    label: 'a model',
    base_url: 'https://models.example.test/v1',
    encrypted_api_key: 'sealed',
    models: ['m-1'],
    is_default: false,
    owner_user_id: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as InferenceConnectionEntity;
}

function user(userId: string): AuthenticatedUser {
  return {
    userId,
    email: `${userId}@example.test`,
    roles: {},
    role: 'member' as IdentityRole,
  };
}

/** A repository that answers from an in-memory table, filters included. */
function fakeRepository(rows: InferenceConnectionEntity[]) {
  const usable = (userId: string) =>
    rows.filter((r) => r.owner_user_id === null || r.owner_user_id === userId);
  return {
    rows,
    deleted: [] as string[],
    created: [] as Record<string, unknown>[],
    clearedFor: [] as (string | null)[],
    findById: jest.fn(
      async (id: string) => rows.find((r) => r.id === id) ?? null,
    ),
    findAll: jest.fn(async () =>
      [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
    ),
    findUsableBy: jest.fn(async (userId: string) => usable(userId)),
    findDefaultUsableBy: jest.fn(
      async (userId: string) =>
        usable(userId)
          .filter((r) => r.is_default)
          .sort(
            (a, b) =>
              (a.owner_user_id === null ? 1 : 0) -
              (b.owner_user_id === null ? 1 : 0),
          )[0] ?? null,
    ),
    clearDefaultFor: jest.fn(async function (this: any, owner: string | null) {
      this.clearedFor.push(owner);
    }),
    updateModels: jest.fn(async () => undefined),
    create: jest.fn(async function (this: any, data: Record<string, unknown>) {
      this.created.push(data);
      return row({
        id: 'created-1',
        owner_user_id: (data.ownerUserId as string | null) ?? null,
      });
    }),
    delete: jest.fn(async function (this: any, id: string) {
      this.deleted.push(id);
      return true;
    }),
  };
}

function resolverOver(repo: ReturnType<typeof fakeRepository>) {
  return new InferenceResolverService(
    { getSupportedProviders: () => [] } as any,
    {} as any,
    { decryptKeyFromString: () => 'the-live-key' } as any,
    repo as any,
  );
}

describe('a connection has an owner, and the owner is asked where the key is spent', () => {
  describe("the installation's connection — what must NOT change", () => {
    it('resolves for the person who did not create it', async () => {
      const repo = fakeRepository([row({ id: 'shared', owner_user_id: null })]);
      const endpoint = await resolverOver(repo).resolveConnection('shared', {
        userId: BOB,
      });
      expect(endpoint.baseUrl).toBe('https://models.example.test/v1');
      expect(endpoint.apiKey).toBe('the-live-key');
    });

    it('resolves for a principal carrying no user id at all', async () => {
      // Not a hypothetical: `principalFromUser` fills an absent user with an
      // empty string, and an unowned row has to survive that rather than
      // becoming a 404 nobody can explain.
      const repo = fakeRepository([row({ id: 'shared', owner_user_id: null })]);
      await expect(
        resolverOver(repo).resolveConnection('shared', { userId: '' }),
      ).resolves.toMatchObject({ apiKey: 'the-live-key' });
    });

    it('is still what an empty selection falls onto for anybody', async () => {
      const repo = fakeRepository([
        row({ id: 'shared', owner_user_id: null, is_default: true }),
      ]);
      await expect(
        resolverOver(repo).resolveDefault({ userId: BOB }),
      ).resolves.toMatchObject({ apiKey: 'the-live-key' });
    });

    it('is listed to a principal holding nothing at all', async () => {
      const repo = fakeRepository([row({ id: 'shared', owner_user_id: null })]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await expect(service.list(user(BOB))).resolves.toMatchObject([
        { id: 'shared', ownerUserId: null },
      ]);
    });
  });

  describe("a person's connection — what must change", () => {
    it('refuses a colleague as absence, not as a refusal', async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      await expect(
        resolverOver(repo).resolveConnection('hers', { userId: BOB }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('says exactly what it says about an id that does not exist', async () => {
      // The point of answering as absence: the two sentences must be the same
      // sentence, or the refusal confirms the row is there.
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const resolver = resolverOver(repo);
      const denied = await resolver
        .resolveConnection('hers', { userId: BOB })
        .catch((e) => e.message);
      const missing = await resolver
        .resolveConnection('hers', { userId: BOB })
        .catch((e) => e.message);
      const absent = await resolver
        .resolveConnection('no-such-row', { userId: BOB })
        .catch((e) => e.message);
      expect(denied).toBe(missing);
      expect(denied).toBe(absent.replace('no-such-row', 'hers'));
    });

    it('resolves for its owner', async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      await expect(
        resolverOver(repo).resolveConnection('hers', { userId: ALICE }),
      ).resolves.toMatchObject({ apiKey: 'the-live-key' });
    });

    it("never becomes a stranger's default, even flagged as one", async () => {
      // The leak that arrives without an id: a personal row marked default
      // would otherwise be handed to every empty selection on the installation.
      const repo = fakeRepository([
        row({ id: 'hers', owner_user_id: ALICE, is_default: true }),
      ]);
      await expect(
        resolverOver(repo).resolveDefault({ userId: BOB }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        resolverOver(repo).resolveDefault({ userId: ALICE }),
      ).resolves.toMatchObject({ apiKey: 'the-live-key' });
    });

    it("does not hide the installation's default from a colleague", async () => {
      // The half a 404 does not prove. If the fallback is chosen blind to the
      // owner, a personal row created later than the installation's is picked
      // first and *then* refused — so the colleague loses an endpoint she was
      // entitled to, and the symptom is "no models configured" rather than
      // anything that names the cause.
      const repo = fakeRepository([
        row({
          id: 'shared',
          owner_user_id: null,
          is_default: true,
          created_at: new Date('2026-01-01T00:00:00Z'),
        }),
        row({
          id: 'hers',
          owner_user_id: ALICE,
          is_default: true,
          created_at: new Date('2026-06-01T00:00:00Z'),
        }),
      ]);
      await expect(
        resolverOver(repo).resolveDefault({ userId: BOB }),
      ).resolves.toMatchObject({ apiKey: 'the-live-key' });
    });

    it('is not in the sole fallback either when nothing is flagged default', async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      await expect(
        resolverOver(repo).resolveDefault({ userId: BOB }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("comes before the installation's for its own owner", async () => {
      const repo = fakeRepository([
        row({ id: 'shared', owner_user_id: null, is_default: true }),
        row({ id: 'hers', owner_user_id: ALICE, is_default: true }),
      ]);
      const chosen = await repo.findDefaultUsableBy(ALICE);
      expect(chosen?.id).toBe('hers');
      expect((await repo.findDefaultUsableBy(BOB))?.id).toBe('shared');
    });

    it("is kept out of a colleague's list", async () => {
      const repo = fakeRepository([
        row({ id: 'shared', owner_user_id: null }),
        row({ id: 'hers', owner_user_id: ALICE }),
      ]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      const listed = await service.list(user(BOB));
      expect(listed.map((c) => c.id)).toEqual(['shared']);
    });

    it('is shown to a principal holding iam:manage-users', async () => {
      const repo = fakeRepository([
        row({ id: 'shared', owner_user_id: null }),
        row({ id: 'hers', owner_user_id: ALICE }),
      ]);
      const service = connectionServiceOver(repo, { seesEveryone: true });
      const listed = await service.list(user(BOB));
      expect(listed.map((c) => c.id).sort()).toEqual(['hers', 'shared']);
      expect(listed.find((c) => c.id === 'hers')?.ownerUserId).toBe(ALICE);
    });

    it('asks iam:manage-users and not integration:manage for that', async () => {
      // The author said "admin", and this product spells that two ways:
      // `integration:manage` reaches maintainer as well, `iam:manage-users`
      // stops at owner. Pinned because widening it later is one line and
      // narrowing it later is a colleague's endpoints already read.
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const asked: string[] = [];
      const service = connectionServiceOver(repo, {
        seesEveryone: false,
        record: asked,
      });
      await service.list(user(BOB));
      expect(asked).toEqual([IAM_PERMISSION.IAM_MANAGE_USERS]);
    });
  });

  describe('the two levels of creation', () => {
    it('writes no owner on the installation route', async () => {
      const repo = fakeRepository([]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await service.create(
        { label: 'l', baseUrl: 'u', apiKey: 'k' } as any,
        null,
      );
      expect(repo.created[0].ownerUserId).toBeNull();
    });

    it('writes the caller as owner on the personal route', async () => {
      const repo = fakeRepository([]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await service.create(
        { label: 'l', baseUrl: 'u', apiKey: 'k' } as any,
        ALICE,
      );
      expect(repo.created[0].ownerUserId).toBe(ALICE);
    });

    it("does not let a person's default unseat the installation's", async () => {
      const repo = fakeRepository([]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await service.create(
        { label: 'l', baseUrl: 'u', apiKey: 'k', isDefault: true } as any,
        ALICE,
      );
      expect(repo.clearedFor).toEqual([ALICE]);
    });
  });

  describe('the two levels of removal', () => {
    it("lets integration:manage remove the installation's row", async () => {
      const repo = fakeRepository([row({ id: 'shared', owner_user_id: null })]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await service.remove('shared', user(BOB));
      expect(repo.deleted).toEqual(['shared']);
    });

    it("hides a colleague's row from the gated route below iam:manage-users", async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await expect(service.remove('hers', user(BOB))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.deleted).toEqual([]);
    });

    it('opens it to iam:manage-users, which is the rung that sees it', async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const service = connectionServiceOver(repo, { seesEveryone: true });
      await service.remove('hers', user(BOB));
      expect(repo.deleted).toEqual(['hers']);
    });

    it('lets a person disconnect her own with no permission at all', async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await service.removeOwn('hers', user(ALICE));
      expect(repo.deleted).toEqual(['hers']);
    });

    it("refuses somebody else's row on that ungated route, as absence", async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const service = connectionServiceOver(repo, { seesEveryone: true });
      await expect(service.removeOwn('hers', user(BOB))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.deleted).toEqual([]);
    });

    it("refuses the installation's row on that ungated route", async () => {
      // Otherwise the split would have given away for free exactly what the
      // gate on the sibling route exists to withhold.
      const repo = fakeRepository([row({ id: 'shared', owner_user_id: null })]);
      const service = connectionServiceOver(repo, { seesEveryone: true });
      await expect(
        service.removeOwn('shared', user(BOB)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.deleted).toEqual([]);
    });
  });

  describe('validating spends the key, so it asks the spend question', () => {
    it("refuses a colleague's connection as absence", async () => {
      const repo = fakeRepository([row({ id: 'hers', owner_user_id: ALICE })]);
      const service = connectionServiceOver(repo, { seesEveryone: true });
      await expect(service.validate('hers', user(BOB))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("still validates the installation's connection for anybody", async () => {
      const repo = fakeRepository([row({ id: 'shared', owner_user_id: null })]);
      const service = connectionServiceOver(repo, { seesEveryone: false });
      await expect(
        service.validate('shared', user(BOB)),
      ).resolves.toMatchObject({ success: true });
    });
  });
});

function connectionServiceOver(
  repo: ReturnType<typeof fakeRepository>,
  opts: { seesEveryone: boolean; record?: string[] },
): InferenceConnectionService {
  const policy = {
    check: jest.fn(async (_p: unknown, action: string) => {
      opts.record?.push(action);
      return opts.seesEveryone;
    }),
  };
  return new InferenceConnectionService(
    repo as any,
    { encryptKeyToString: () => 'sealed' } as any,
    { isHostedMode: () => false } as any,
    { listModelIds: async () => ['m-1'] } as any,
    resolverOver(repo),
    policy as any,
  );
}

/**
 * The count, and the reason it is pinned rather than described.
 *
 * The first pass at this measured the callers of the function that *decrypts*
 * and found four; the door is the function that *chooses*, and it has ten
 * callers. A second reading then counted thirteen in eleven files, by grepping
 * a name that two unrelated private methods in the DNS module happen to share.
 * Both numbers were arrived at honestly and both were wrong, which is why the
 * answer now lives in an assertion: the next person to change this surface gets
 * told, instead of counting again.
 */
describe('every place that turns a request body into a key passes who is asking', () => {
  const MODULES = join(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
        out.push(full);
    }
    return out;
  }

  /** The argument list of a call, split at depth 1 so nested calls do not fool it. */
  function argumentsOf(text: string, openParen: number): string[] {
    let depth = 0;
    let current = '';
    const args: string[] = [];
    for (let i = openParen; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        if (depth === 1) continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          args.push(current);
          return args.map((a) => a.trim()).filter((a) => a.length > 0);
        }
      }
      if (ch === ',' && depth === 1) {
        args.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    return args;
  }

  interface Call {
    file: string;
    receiver: string;
    args: string[];
  }

  const calls: Call[] = [];
  for (const file of sourceFiles(MODULES)) {
    const text = readFileSync(file, 'utf8');
    const re = /([A-Za-z0-9_.]*)\.?resolveEndpoint\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // Skip the declaration itself, which is not a call.
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (/\basync\s+$|\bprivate async\s+$/.test(before)) continue;
      calls.push({
        file: file.slice(MODULES.length + 1),
        receiver: m[1].replace(/\.$/, ''),
        args: argumentsOf(text, m.index + m[0].length - 1),
      });
    }
  }

  const spenders = calls.filter((c) => c.receiver === 'this.inference');
  const others = calls.filter((c) => c.receiver !== 'this.inference');

  it('finds ten of them, in eight files', () => {
    expect(spenders).toHaveLength(10);
    expect([...new Set(spenders.map((c) => c.file))].sort()).toEqual([
      'assistant/services/assistant-agent.service.ts',
      'assistant/services/assistant.service.ts',
      'database-console/services/db-assist.service.ts',
      'database-console/services/document-assist.service.ts',
      'database-console/services/fulltext-assist.service.ts',
      'database-console/services/kafka-assist.service.ts',
      'database-console/services/kv-assist.service.ts',
      'database-console/services/search-assist.service.ts',
    ]);
  });

  it('passes a principal at every one of them', () => {
    const bare = spenders.filter((c) => c.args.length < 2);
    expect(bare.map((c) => c.file)).toEqual([]);
  });

  it('names the same-named function that is a different function', () => {
    // Two private helpers in the DNS module resolve an *application's* endpoint
    // and have nothing to do with inference. Counting them in is how thirteen
    // came out of a grep that should have said ten.
    expect([...new Set(others.map((c) => c.file))].sort()).toEqual([
      'dns/services/api-domain-sync.service.ts',
      'dns/services/web-domain-sync.service.ts',
    ]);
  });
});
