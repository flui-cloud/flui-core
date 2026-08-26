import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AgentActivityService } from './agent-activity.service';
import { ActivityFilter } from './agent-activity.query';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiKeyEntity } from '../../auth/entities/api-key.entity';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { AgentConcessionEntity } from '../../action-cycle/entities/agent-concession.entity';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

const OWNER = 'u-owner';
const OTHER = 'u-other';

const caller = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    userId: OWNER,
    email: 'owner@acme.com',
    isAdmin: false,
    ...over,
  }) as AuthenticatedUser;

const logRow = (
  over: Partial<McpToolCallLogEntity> = {},
): McpToolCallLogEntity =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    user_id: OWNER,
    tool: 'cluster_add_worker',
    scope: MCP_SCOPE.BACKUP_WRITE,
    allowed: true,
    error: null,
    outcome: null,
    actor_kind: 'agent',
    actor_key_id: 'k-1',
    args: { nodeType: 'worker', name: '****' },
    operation_id: 'op-1',
    proposal_id: null,
    created_at: new Date('2026-08-24T10:00:00Z'),
    ...over,
  }) as McpToolCallLogEntity;

const operationRow = (
  over: Partial<InfrastructureOperationEntity> = {},
): InfrastructureOperationEntity =>
  ({
    id: 'op-1',
    operationType: OperationType.ADD_WORKER,
    status: OperationStatus.IN_PROGRESS,
    progress: 40,
    resourceType: 'cluster',
    resourceName: 'control-cluster',
    resourceId: 'c-1',
    userId: OWNER,
    grantId: 'concession-1',
    // Where a secret would be if the join ever handed the row back whole.
    metadata: { serverConfig: { rootPassword: 'hunter2' } },
    ...over,
  }) as unknown as InfrastructureOperationEntity;

interface Harness {
  service: AgentActivityService;
  audit: { page: jest.Mock; findById: jest.Mock; identities: jest.Mock };
  lastFilter: () => ActivityFilter | undefined;
}

/** The two repositories answer two questions each; the `where` says which. */
interface FindArgs {
  where?: { grantId?: unknown; fromProposalId?: unknown };
}

function build(
  opts: {
    rows?: McpToolCallLogEntity[];
    operations?: InfrastructureOperationEntity[];
    /** What `?proposalId=` finds: the operations stamped with that answer. */
    underGrant?: Partial<InfrastructureOperationEntity>[];
    /** The standing permissions born from that same request. */
    fromProposal?: Partial<AgentConcessionEntity>[];
    keys?: Partial<ApiKeyEntity>[];
    canReadAccess?: boolean;
    isAdmin?: boolean;
    infrastructure?: 'full' | 'view';
    identities?: unknown[];
    concessions?: unknown[];
  } = {},
): Harness {
  let captured: ActivityFilter | undefined;
  const audit = {
    page: jest.fn(async (filter: ActivityFilter) => {
      captured = filter;
      return { rows: opts.rows ?? [logRow()], total: opts.rows?.length ?? 1 };
    }),
    findById: jest.fn(async () => opts.rows?.[0] ?? logRow()),
    identities: jest.fn(async (filter: ActivityFilter) => {
      captured = filter;
      return opts.identities ?? [];
    }),
  };
  const keys = {
    find: jest.fn(
      async () =>
        opts.keys ?? [
          { id: 'k-1', name: 'release-bot', revoked: false, lastUsedAt: null },
        ],
    ),
  };
  const operations = {
    find: jest.fn(async (args: FindArgs) =>
      args?.where?.grantId !== undefined
        ? (opts.underGrant ?? [])
        : (opts.operations ?? [operationRow()]),
    ),
  };
  const concessions = {
    find: jest.fn(async (args: FindArgs) =>
      args?.where?.fromProposalId !== undefined
        ? (opts.fromProposal ?? [])
        : (opts.concessions ?? []),
    ),
  };
  const policy = {
    resolveAccess: jest.fn().mockResolvedValue({ isAdmin: !!opts.isAdmin }),
    can: jest.fn().mockReturnValue(!!opts.canReadAccess || !!opts.isAdmin),
    resolveSectionAccess: jest
      .fn()
      .mockResolvedValue([
        { key: 'infrastructure', level: opts.infrastructure ?? 'view' },
      ]),
  } as unknown as PolicyEngine;

  return {
    service: new AgentActivityService(
      audit as unknown as McpAuditRepository,
      keys as unknown as Repository<ApiKeyEntity>,
      operations as unknown as Repository<InfrastructureOperationEntity>,
      concessions as unknown as Repository<AgentConcessionEntity>,
      policy,
    ),
    audit,
    lastFilter: () => captured,
  };
}

describe('GET /agent/activity — the register, read back', () => {
  it('names the key rather than only its id, and says the page is own', async () => {
    const { service } = build();
    const page = await service.page(caller(), {});
    expect(page.scope).toBe('own');
    expect(page.entries[0]).toMatchObject({
      actorKind: 'agent',
      actorKeyId: 'k-1',
      actorKeyName: 'release-bot',
      actorKeyRevoked: false,
      tool: 'cluster_add_worker',
    });
  });

  it('keeps the row when the key it names has been deleted', async () => {
    const { service } = build({ keys: [] });
    const page = await service.page(caller(), {});
    expect(page.entries[0].actorKeyId).toBe('k-1');
    expect(page.entries[0].actorKeyName).toBeNull();
  });

  it('pins the caller to their own rows', async () => {
    const { service, lastFilter } = build();
    await service.page(caller(), {});
    expect(lastFilter()?.userId).toBe(OWNER);
  });

  it("answers an empty page — not a refusal — for somebody else's rows", async () => {
    const { service, audit } = build();
    const page = await service.page(caller(), { userId: OTHER });
    expect(page).toMatchObject({ scope: 'own', total: 0, entries: [] });
    // The query is never issued: a filter carrying the asked-for id would have
    // answered with that person's rows.
    expect(audit.page).not.toHaveBeenCalled();
  });

  it('lets whoever administers access read the whole instance', async () => {
    const { service, lastFilter } = build({ canReadAccess: true });
    const page = await service.page(caller(), {});
    expect(page.scope).toBe('instance');
    expect(lastFilter()?.userId).toBeUndefined();
  });

  it('passes the narrowing through to the query', async () => {
    const { service, lastFilter } = build();
    await service.page(caller(), {
      actorKind: 'agent',
      keyId: 'k-1',
      tool: 'app_delete',
      allowed: 'false',
      since: '2026-08-01T00:00:00.000Z',
    });
    expect(lastFilter()).toMatchObject({
      actorKind: 'agent',
      actorKeyId: 'k-1',
      tool: 'app_delete',
      allowed: false,
      since: new Date('2026-08-01T00:00:00.000Z'),
    });
  });
});

describe('the stitch to the operation', () => {
  it('recovers what was acted on, which the arguments cannot say', async () => {
    const { service } = build();
    const page = await service.page(caller(), {});
    expect(page.entries[0].operation).toMatchObject({
      id: 'op-1',
      operationType: OperationType.ADD_WORKER,
      status: OperationStatus.IN_PROGRESS,
      resourceName: 'control-cluster',
      grantId: 'concession-1',
    });
  });

  /**
   * The one that matters. `metadata` never passed the argument redactor — it is
   * whatever the caller of the day put there — so handing the operation row
   * back whole would return through the join exactly what the column beside it
   * withholds.
   */
  it('never carries the operation metadata across', async () => {
    const { service } = build();
    const page = await service.page(caller(), {});
    const rendered = JSON.stringify(page.entries[0]);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('metadata');
    expect(page.entries[0].operation).not.toHaveProperty('metadata');
  });

  it('hands back the stored arguments unchanged, redaction included', async () => {
    const { service } = build();
    const page = await service.page(caller(), {});
    expect(page.entries[0].args).toEqual({
      nodeType: 'worker',
      name: '****',
    });
  });

  it('drops the detail, keeping the id, for an operation the caller may not read', async () => {
    const { service } = build({
      canReadAccess: true,
      operations: [operationRow({ userId: OTHER })],
      rows: [logRow({ user_id: OTHER })],
    });
    const page = await service.page(caller(), {});
    expect(page.entries[0].operationId).toBe('op-1');
    expect(page.entries[0].operation).toBeNull();
  });

  it('gives it to an operator of the instance', async () => {
    const { service } = build({
      canReadAccess: true,
      infrastructure: 'full',
      operations: [operationRow({ userId: OTHER })],
      rows: [logRow({ user_id: OTHER })],
    });
    const page = await service.page(caller(), {});
    expect(page.entries[0].operation?.resourceName).toBe('control-cluster');
  });

  /**
   * A credential scoped to read the access graph is refused
   * `GET /infrastructure/operations/:id` by the ceiling. It must not receive
   * the same content sideways because it happened to arrive through the
   * register.
   */
  it('withholds it from a credential whose ceiling excludes app:read', async () => {
    const { service } = build({ canReadAccess: true });
    const page = await service.page(
      caller({ isAdmin: true, scopes: [MCP_SCOPE.IAM_READ] }),
      {},
    );
    expect(page.scope).toBe('instance');
    expect(page.entries[0].operationId).toBe('op-1');
    expect(page.entries[0].operation).toBeNull();
  });
});

describe('under which permission it happened', () => {
  /**
   * The mockup's fourth rule. `grantId` holds a concession id or a proposal id
   * and cannot say which, so the register resolves it — otherwise a person
   * taking a permission back is reading a column that means two things.
   */
  it('names the standing permission, with the words that were read', async () => {
    const { service } = build({
      concessions: [
        {
          id: 'concession-1',
          ownerUserId: OWNER,
          sentence: 'add nodes to control-cluster',
        },
      ],
    });
    const page = await service.page(caller(), {});
    expect(page.entries[0].under).toBe('concession');
    expect(page.entries[0].underSentence).toBe('add nodes to control-cluster');
  });

  it('reads a grant that is no concession as the one-off approval', async () => {
    const { service } = build({ concessions: [] });
    const page = await service.page(caller(), {});
    expect(page.entries[0].under).toBe('approval');
    expect(page.entries[0].underSentence).toBeNull();
  });

  it("withholds somebody else's wording while still naming the kind", async () => {
    const { service } = build({
      canReadAccess: true,
      infrastructure: 'full',
      rows: [logRow({ user_id: OTHER })],
      operations: [operationRow({ userId: OTHER })],
      concessions: [
        {
          id: 'concession-1',
          ownerUserId: OTHER,
          sentence: 'add nodes to control-cluster',
        },
      ],
    });
    const page = await service.page(caller(), {});
    expect(page.entries[0].under).toBe('concession');
    expect(page.entries[0].underSentence).toBeNull();
  });

  it('says nothing at all for a call that started no operation', async () => {
    const { service } = build({ rows: [logRow({ operation_id: null })] });
    const page = await service.page(caller(), {});
    expect(page.entries[0].under).toBeNull();
    expect(page.entries[0].operation).toBeNull();
  });
});

/**
 * The second residue: `under` was null on most rows and mute about it, so an
 * empty column read as a defect of the register rather than as a fact about the
 * call. Nothing here invents a permission — each answer is read off something
 * already stored.
 */
describe('and when it names none, why', () => {
  it('says the route never pauses, for the majority of rows', async () => {
    const { service } = build({
      operations: [operationRow({ grantId: null })],
    });
    const page = await service.page(caller(), {});
    expect(page.entries[0].under).toBeNull();
    expect(page.entries[0].underAbsent).toBe('not-paused');
    expect(page.entries[0].underAbsentReason).toContain('no answer to record');
  });

  it('holds "started nothing" apart from "started something you cannot see"', async () => {
    const started = build({ rows: [logRow({ operation_id: null })] });
    expect((await started.service.page(caller(), {})).entries[0]).toMatchObject(
      { underAbsent: 'no-operation' },
    );

    // The same null the caller used to get for both, now distinguished: the
    // operation exists, the id is on the row, and the answer behind it is not
    // this reader's to see.
    const hidden = build({
      canReadAccess: true,
      operations: [operationRow({ userId: OTHER })],
      rows: [logRow({ user_id: OTHER })],
    });
    expect((await hidden.service.page(caller(), {})).entries[0]).toMatchObject({
      operationId: 'op-1',
      operation: null,
      underAbsent: 'operation-withheld',
    });
  });

  it('says a refused call had no permission behind it', async () => {
    const { service } = build({
      rows: [
        logRow({ allowed: false, error: 'missing scope', operation_id: null }),
      ],
    });
    expect((await service.page(caller(), {})).entries[0]).toMatchObject({
      underAbsent: 'refused',
    });
  });

  /**
   * A waiting turn is `allowed: true, error: null` on this table. Read off
   * `allowed` alone it would be reported as "the route never pauses", which is
   * precisely the opposite of what happened to it.
   */
  it('says a turn that stopped to ask is waiting, not unpaused', async () => {
    const { service } = build({
      rows: [logRow({ outcome: 'input_required', operation_id: null })],
    });
    expect((await service.page(caller(), {})).entries[0]).toMatchObject({
      underAbsent: 'waiting',
    });
  });

  it('is null exactly when a permission is named', async () => {
    const { service } = build({ concessions: [] });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.under).toBe('approval');
    expect(entry.underAbsent).toBeNull();
    expect(entry.underAbsentReason).toBeNull();
  });
});

/**
 * The first residue: the proposal and the register row never spoke. The
 * direction a review walks — from a call back to the request that let it
 * through — was already derivable and was being discarded.
 */
describe('the request behind a call', () => {
  it('names it when a one-off was spent, which is the id the guard stamped', async () => {
    const { service } = build({ concessions: [] });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.under).toBe('approval');
    expect(entry.proposalId).toBe('concession-1');
  });

  it('reaches it through the standing permission it produced', async () => {
    const { service } = build({
      concessions: [
        {
          id: 'concession-1',
          ownerUserId: OWNER,
          sentence: 'add nodes to control-cluster',
          fromProposalId: 'p-9',
        },
      ],
    });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.under).toBe('concession');
    expect(entry.proposalId).toBe('p-9');
  });

  it('leaves it unknown rather than guessed when the concession does not say', async () => {
    const { service } = build({
      concessions: [
        { id: 'concession-1', ownerUserId: OWNER, sentence: 'add nodes' },
      ],
    });
    expect((await service.page(caller(), {})).entries[0].proposalId).toBeNull();
  });

  it('is absent on a row nothing answered for', async () => {
    const { service } = build({
      operations: [operationRow({ grantId: null })],
    });
    expect((await service.page(caller(), {})).entries[0].proposalId).toBeNull();
  });
});

describe('and the other way round — what a request authorised', () => {
  it('gathers the one-off and everything the standing permission let through', async () => {
    const { service, lastFilter } = build({
      fromProposal: [{ id: 'concession-1' }],
      underGrant: [{ id: 'op-1' }, { id: 'op-7' }],
    });
    await service.page(caller(), { proposalId: 'p-9' });
    expect(lastFilter()?.operationIds).toEqual(['op-1', 'op-7']);
    // Still pinned: the narrowing is a narrowing, never a way around the reach.
    expect(lastFilter()?.userId).toBe(OWNER);
  });

  /**
   * A request that authorised nothing — or one belonging to somebody else, which
   * from here is the same observation. Empty, never the unfiltered register.
   */
  it('narrows to the empty set for a request that carried nothing', async () => {
    const { service, lastFilter } = build({ underGrant: [] });
    await service.page(caller(), { proposalId: 'p-9' });
    // The empty array reaches the query as `1 = 0` rather than as "no opinion"
    // — asserted where the filter becomes SQL.
    expect(lastFilter()?.operationIds).toEqual([]);
  });

  it('leaves the page alone when no request is named', async () => {
    const { service, lastFilter } = build();
    await service.page(caller(), {});
    expect(lastFilter()?.operationIds).toBeUndefined();
    expect(lastFilter()?.raisedProposalId).toBeUndefined();
  });

  /**
   * The half that could not be derived. The turn that stopped to ask departed
   * under nothing, so it is in no operation set: without the column it fell out
   * of the answer to "what is this request", which is the one row somebody
   * reviewing it starts from.
   */
  it('takes in the turn that raised the request, not only what it authorised', async () => {
    const { service, lastFilter } = build({ underGrant: [{ id: 'op-1' }] });
    await service.page(caller(), { proposalId: 'p-9' });
    expect(lastFilter()?.raisedProposalId).toBe('p-9');
    expect(lastFilter()?.operationIds).toEqual(['op-1']);
  });

  it('names the request on the row that raised it', async () => {
    const { service } = build({
      rows: [
        logRow({
          outcome: 'input_required',
          operation_id: null,
          proposal_id: 'p-9',
        }),
      ],
    });
    const [entry] = (await service.page(caller(), {})).entries;
    expect(entry.raisedProposalId).toBe('p-9');
    // It asked; nothing answered yet. The two fields are not the same fact.
    expect(entry.proposalId).toBeNull();
    expect(entry.underAbsent).toBe('waiting');
  });

  it('leaves it empty on a call that asked for nothing', async () => {
    const { service } = build({ rows: [logRow()] });
    const [entry] = (await service.page(caller(), {})).entries;
    expect(entry.raisedProposalId).toBeNull();
  });

  /**
   * The shape a row cannot have any more, and the reason the reader does not
   * cover for it.
   *
   * Both surfaces that stop to ask write the outcome now — the MCP server and
   * the portal's assistant — so a row naming a request without one is a writer
   * that forgot, not a second kind of wait. Classifying it `waiting` off the
   * request alone would give the right answer and hide the writer, and the
   * register exists to show what happened, not to make it look consistent.
   */
  it('does not dress a missing outcome up as a wait, even when a request is named', async () => {
    const { service } = build({
      rows: [
        logRow({
          allowed: true,
          outcome: null,
          operation_id: null,
          proposal_id: 'p-9',
        }),
      ],
    });
    const [entry] = (await service.page(caller(), {})).entries;
    expect(entry.raisedProposalId).toBe('p-9');
    expect(entry.underAbsent).toBe('no-operation');
  });
});

/**
 * The third residue, and the same class as the credential leak found earlier in
 * this series: `error` is a string built downstream by concatenation — SSH
 * stderr, a whole provider response body — and it was handed to every reader of
 * the panel verbatim, a sandbox guest included.
 */
describe('the failure text, and who reads it', () => {
  const leaky = () =>
    logRow({
      allowed: true,
      error: 'SSH exec failed (code 1): token=hunter2',
    });

  it('withholds it from a caller reading only their own rows', async () => {
    const { service } = build({ rows: [leaky()] });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.errorWithheld).toBe(true);
    expect(entry.error).not.toContain('hunter2');
    expect(entry.error).toMatch(/^Failed\./);
  });

  it('hands it whole to whoever administers access, from a session', async () => {
    const { service } = build({ canReadAccess: true, rows: [leaky()] });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.errorWithheld).toBe(false);
    expect(entry.error).toContain('hunter2');
  });

  /**
   * `mcp:iam:read` carries `iam:read-access`, so an agent credential minted for
   * it reaches instance scope on this register. It must not thereby page every
   * failure text in the product into a model's context.
   */
  it('withholds it from an agent credential that reaches the whole instance', async () => {
    const { service } = build({ canReadAccess: true, rows: [leaky()] });
    const page = await service.page(
      caller({ isAdmin: true, scopes: [MCP_SCOPE.IAM_READ] }),
      {},
    );
    expect(page.scope).toBe('instance');
    expect(page.entries[0].errorWithheld).toBe(true);
    expect(page.entries[0].error).not.toContain('hunter2');
  });

  it('lets a refusal written entirely in Flui words through', async () => {
    const { service } = build({
      rows: [logRow({ allowed: false, error: 'missing scope' })],
    });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.error).toBe('missing scope');
    expect(entry.errorWithheld).toBe(false);
  });

  it('keeps a clean call clean rather than inventing a sentence', async () => {
    const { service } = build();
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.error).toBeNull();
    expect(entry.errorWithheld).toBe(false);
  });

  /** The by-id route reads the same rows and must not be the way around this. */
  it('applies the same boundary on the single-row route', async () => {
    const { service } = build({ rows: [leaky()] });
    const entry = await service.entry(caller(), 'any');
    expect(entry.errorWithheld).toBe(true);
    expect(entry.error).not.toContain('hunter2');
  });
});

describe('GET /agent/activity/:id', () => {
  it('answers 404 for a row belonging to somebody else', async () => {
    const { service } = build({ rows: [logRow({ user_id: OTHER })] });
    await expect(service.entry(caller(), 'any')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers the row for its owner', async () => {
    const { service } = build();
    await expect(service.entry(caller(), 'any')).resolves.toMatchObject({
      tool: 'cluster_add_worker',
    });
  });
});

describe('GET /agent/activity/identities — the last activity', () => {
  it('reports it beside the key name and the key own last authentication', async () => {
    const { service } = build({
      identities: [
        {
          actorKind: 'agent',
          actorKeyId: 'k-1',
          userId: OWNER,
          calls: 12,
          refused: 2,
          lastActivityAt: new Date('2026-08-24T10:00:00Z'),
          lastTool: 'cluster_add_worker',
          lastOutcome: null,
          lastAllowed: true,
        },
      ],
      keys: [
        {
          id: 'k-1',
          name: 'release-bot',
          revoked: true,
          lastUsedAt: new Date('2026-08-24T11:00:00Z'),
        },
      ],
    });
    const { identities } = await service.identities(caller(), {});
    expect(identities[0]).toMatchObject({
      actorKeyName: 'release-bot',
      actorKeyRevoked: true,
      keyLastUsedAt: new Date('2026-08-24T11:00:00Z'),
      lastActivityAt: new Date('2026-08-24T10:00:00Z'),
      lastTool: 'cluster_add_worker',
      calls: 12,
      refused: 2,
    });
  });

  it('is pinned to the caller the same way the page is', async () => {
    const { service, lastFilter } = build({ identities: [] });
    const page = await service.identities(caller(), {});
    expect(page.scope).toBe('own');
    expect(lastFilter()?.userId).toBe(OWNER);
  });

  it("answers empty for another person's identities without asking", async () => {
    const { service, audit } = build();
    const page = await service.identities(caller(), { userId: OTHER });
    expect(page.identities).toEqual([]);
    expect(audit.identities).not.toHaveBeenCalled();
  });
});

/**
 * The claim the sandbox fence now depends on, asserted in one place.
 *
 * Opening `/agent/activity*` to a guest is only safe because the handler pins
 * the rows before it builds a filter. A guest holds no section, so it can never
 * acquire `iam:read-access` and can never be widened past its own register —
 * and the three routes have to agree about that, because a client picks
 * whichever one answers its screen.
 */
describe('a sandbox guest, on all three routes', () => {
  const guest = () => caller({ userId: 'u-guest' });

  it('reads its own register', async () => {
    const { service, lastFilter } = build({
      rows: [logRow({ user_id: 'u-guest' })],
    });
    const page = await service.page(guest(), {});
    expect(page.scope).toBe('own');
    expect(lastFilter()?.userId).toBe('u-guest');
    expect(page.entries[0].userId).toBe('u-guest');
  });

  it("never reads another guest's, however it asks", async () => {
    const { service, audit } = build();

    const page = await service.page(guest(), { userId: OTHER });
    const identities = await service.identities(guest(), { userId: OTHER });

    expect(page.entries).toEqual([]);
    expect(identities.identities).toEqual([]);
    expect(audit.page).not.toHaveBeenCalled();
    expect(audit.identities).not.toHaveBeenCalled();

    // And by id, which is the way past a filter: absent, not refused.
    await expect(service.entry(guest(), 'act-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * The sharpest case for the error boundary. A guest's tools run against
   * infrastructure it shares, so a failure text produced there can carry
   * something that was never the guest's to read — and the guest can never
   * acquire the reach that would entitle it to the whole text.
   */
  it('is told that a failure failed, and not what the failing thing said', async () => {
    const { service } = build({
      rows: [
        logRow({
          user_id: 'u-guest',
          error: 'SSH exec failed (code 1): token=hunter2',
        }),
      ],
    });
    const entry = (await service.page(guest(), {})).entries[0];
    expect(entry.errorWithheld).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });
});

/**
 * The rows the door writes: an agent that used its key over plain HTTP, with no
 * MCP server and no assistant in front of it.
 *
 * They are the case the register could not describe at all until now, and the
 * one thing they cannot have is an operation: a guard runs before the handler,
 * so it knows the verdict and never learns what the call went on to create.
 * Everything the panel shows about them therefore has to come off the row.
 */
describe('a call that came straight at a route', () => {
  const doorRow = (over: Partial<McpToolCallLogEntity> = {}) =>
    logRow({
      tool: 'POST /applications/:id/deploy',
      scope: 'app:write',
      surface: 'api',
      operation_id: null,
      args: null,
      ...over,
    });

  it('says which door it came through', async () => {
    const { service } = build({ rows: [doorRow()] });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.surface).toBe('api');
    expect(entry.tool).toBe('POST /applications/:id/deploy');
    expect(entry.scope).toBe('app:write');
  });

  /**
   * A row written before the column existed is not a claim that the call came
   * through the API, exactly as a null `actorKind` is not a claim that a person
   * made it.
   */
  it('leaves an older row unlabelled rather than calling it `api`', async () => {
    const { service } = build({ rows: [logRow({ surface: null })] });
    expect((await service.page(caller(), {})).entries[0].surface).toBeNull();
  });

  it('names the standing permission it departed under, with no operation to go through', async () => {
    const { service } = build({
      rows: [doorRow({ grant_id: 'concession-1', outcome: 'departed' })],
      concessions: [
        {
          id: 'concession-1',
          ownerUserId: OWNER,
          sentence: 'deploy application app-1 whenever it asks',
          fromProposalId: 'p-7',
        },
      ],
    });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.outcome).toBe('departed');
    expect(entry.under).toBe('concession');
    expect(entry.underSentence).toBe(
      'deploy application app-1 whenever it asks',
    );
    expect(entry.proposalId).toBe('p-7');
    // The column is not empty, so there is no reason for it to be.
    expect(entry.underAbsent).toBeNull();
  });

  it('reads a grant no concession answers to as the one-off it is', async () => {
    const { service } = build({
      rows: [doorRow({ grant_id: 'p-9' })],
      concessions: [],
    });
    const entry = (await service.page(caller(), {})).entries[0];
    expect(entry.under).toBe('approval');
    expect(entry.proposalId).toBe('p-9');
  });

  /**
   * Without this the register would answer "what did this request authorise"
   * with the departures it can see through an operation, and silently drop the
   * ones that never started one.
   */
  it('is reached by asking what a request authorised', async () => {
    const { service, lastFilter } = build({
      rows: [doorRow({ grant_id: 'c-1' })],
      fromProposal: [{ id: 'c-1' }],
      underGrant: [],
    });
    await service.page(caller(), {
      proposalId: '22222222-2222-4222-8222-222222222222',
    });
    expect(lastFilter()?.grantIds).toEqual([
      '22222222-2222-4222-8222-222222222222',
      'c-1',
    ]);
  });

  it('passes a narrowing by door through to the query', async () => {
    const { service, lastFilter } = build();
    await service.page(caller(), { surface: 'api' });
    expect(lastFilter()?.surface).toBe('api');
  });
});
