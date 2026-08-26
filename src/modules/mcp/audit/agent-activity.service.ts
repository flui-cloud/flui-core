import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiKeyEntity } from '../../auth/entities/api-key.entity';
import { ceilingWithholds } from '../../auth/utils/credential-ceiling.util';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { InfrastructureOperationEntity } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AgentConcessionEntity } from '../../action-cycle/entities/agent-concession.entity';
import { readsEveryOperation } from '../../infrastructure/operations/helpers/operation-ownership.helper';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { ActivityFilter } from './agent-activity.query';
import { ActivityReach, activityReach } from './agent-activity.reach';
import {
  UNDER_ABSENT_REASON,
  proposalBehind,
  underAbsentFor,
} from './agent-activity.answer';
import {
  discloseRegisterError,
  readsErrorsVerbatim,
} from './register-error-disclosure';
import {
  AgentActivityEntryDto,
  AgentActivityOperationDto,
  AgentActivityPageDto,
  AgentActivityQueryDto,
  AgentIdentityActivityDto,
  AgentIdentityActivityPageDto,
  AgentIdentityActivityQueryDto,
} from './dto/agent-activity.dto';

const DEFAULT_PAGE = 50;
const DEFAULT_IDENTITIES = 100;

/** What one key contributes to a row, looked up once per page. */
interface KeyFacts {
  name: string;
  revoked: boolean;
  lastUsedAt: Date | null;
}

/** The narrowing both reads accept, as strings off the query string. */
interface ActivityQuery {
  userId?: string;
  actorKind?: string;
  surface?: string;
  keyId?: string;
  tool?: string;
  outcome?: string;
  allowed?: string;
  operationId?: string;
  proposalId?: string;
  since?: string;
  until?: string;
}

/** What one grant id resolves to, once the concessions table has been asked. */
interface AnswerFacts {
  under: 'concession' | 'approval';
  sentence: string | null;
  proposalId: string | null;
}

/**
 * "What it did": the register read back, stitched to the operations the calls
 * started and to the names of the credentials that made them.
 *
 * Three joins the table cannot do for itself, and each is a deliberate absence
 * of a column rather than an oversight:
 *
 *  - **the key's name.** `actor_key_id` is not a foreign key, because the
 *    record of what happened has to outlive the credential that did it. So the
 *    name is fetched beside the page and a deleted key simply has none — which
 *    is a truthful "we no longer know what it was called", not a broken row;
 *  - **the operation.** The arguments are redacted, so the log cannot say
 *    *which* application was touched; the operations row can, because the
 *    server wrote `resourceName` itself. `operation_id` is the whole join, and
 *    it is projected field by field — never the row — for the reason spelled
 *    out on {@link AgentActivityOperationDto};
 *  - **the last activity per identity.** Derived from this same table with a
 *    fold, never a column somebody has to keep true.
 *
 * A fourth join is derived rather than absent: **the request a call departed
 * under**. `action_proposals` and this table share no column, but the operation
 * in between carries the id the guard stamped, and that id is either a proposal
 * or a concession that records the proposal it came from. Both directions are
 * answered from it — `proposalId` on a row, and `?proposalId=` on the page.
 *
 * The other half of that link — the turn that *raised* a request — could be
 * derived from nothing at all and now has a column, `proposal_id`, read here as
 * `raisedProposalId` and OR-ed into the `?proposalId=` narrowing. It is the one
 * of the four this service does not work out for itself: the value is written
 * where the wait is seen.
 *
 * **And that derivation has a floor.** It walks through the operation a call
 * started, which only exists for a call whose *result* could be read — and a
 * row written by the door itself has no result: a guard runs before the
 * handler. Those rows name their answer directly, in `grant_id`, and are read
 * here first; the operation is the fallback, not the source. Without it a call
 * that a standing permission let through would show a register that knows the
 * call happened and cannot say what allowed it, which is precisely the column
 * the mockup's fourth rule is about.
 */
@Injectable()
export class AgentActivityService {
  constructor(
    private readonly audit: McpAuditRepository,
    @InjectRepository(ApiKeyEntity)
    private readonly keys: Repository<ApiKeyEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectRepository(AgentConcessionEntity)
    private readonly concessions: Repository<AgentConcessionEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async page(
    user: AuthenticatedUser,
    query: AgentActivityQueryDto,
  ): Promise<AgentActivityPageDto> {
    const reach = await activityReach(this.policy, user);
    const limit = query.limit ?? DEFAULT_PAGE;
    const offset = query.offset ?? 0;
    const filter = this.filterFor(reach, user, query);
    const narrowed = filter && (await this.narrowToRequest(filter, query));
    if (!narrowed) {
      return { scope: reach, total: 0, limit, offset, entries: [] };
    }
    const { rows, total } = await this.audit.page(narrowed, limit, offset);
    return {
      scope: reach,
      total,
      limit,
      offset,
      entries: await this.describe(user, reach, rows),
    };
  }

  /**
   * `?proposalId=` — "what did this request actually authorise", answered
   * without a column joining the two tables.
   *
   * One request can be answered twice over: the one-off stamps its own id on
   * whatever departs, and an "always" writes a concession whose id is stamped on
   * everything that departs afterwards. Both are gathered, turned into the set
   * of operations they carried, and handed to the page as an `IN`.
   *
   * Plus the turn that *raised* it, which departed under nothing and is in no
   * operation set — it names the request in a column of its own. OR-ed with the
   * departures, so the answer to "what is this request" is the asking and the
   * doing together, which is the order somebody reviewing it reads them in.
   *
   * It discloses nothing, and not because of a check made here: the filter it
   * narrows is already pinned to the caller's own rows unless they read the
   * whole instance. Naming a request that is not theirs therefore narrows their
   * own rows to none, which is the same answer the register gives to every other
   * question about somebody else's things.
   */
  private async narrowToRequest(
    filter: ActivityFilter,
    query: ActivityQuery,
  ): Promise<ActivityFilter | null> {
    const proposalId = query.proposalId;
    if (!proposalId) return filter;
    const standing = await this.concessions.find({
      where: { fromProposalId: proposalId },
      select: ['id'],
    });
    const grants = [proposalId, ...standing.map((c) => c.id)];
    const operations = await this.operations.find({
      where: { grantId: In(grants) },
      select: ['id'],
    });
    return {
      ...filter,
      operationIds: operations.map((o) => o.id),
      // The same grants, asked of the rows directly. A call written by the door
      // starts no operation this can go through — a guard runs before the
      // handler — so without this the register would answer "what did this
      // request authorise" with the departures it could see and silently drop
      // the ones it could not.
      grantIds: grants,
      raisedProposalId: proposalId,
    };
  }

  /**
   * One row by id, or a 404 — including for a row that exists and belongs to
   * somebody else.
   *
   * The same shape the fence already gives an owned resource: refusing with
   * "forbidden" would confirm that this exact call happened, which is the thing
   * being withheld.
   */
  async entry(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AgentActivityEntryDto> {
    const reach = await activityReach(this.policy, user);
    const row = await this.audit.findById(id);
    if (!row || (reach === 'own' && row.user_id !== user.userId)) {
      throw new NotFoundException(`Activity ${id} not found`);
    }
    const [entry] = await this.describe(user, reach, [row]);
    return entry;
  }

  async identities(
    user: AuthenticatedUser,
    query: AgentIdentityActivityQueryDto,
  ): Promise<AgentIdentityActivityPageDto> {
    const reach = await activityReach(this.policy, user);
    const filter = this.filterFor(reach, user, query);
    if (!filter) return { scope: reach, identities: [] };
    const summaries = await this.audit.identities(
      filter,
      query.limit ?? DEFAULT_IDENTITIES,
    );
    const keyFacts = await this.keyFacts(
      summaries.map((s) => s.actorKeyId).filter((id): id is string => !!id),
    );
    return {
      scope: reach,
      identities: summaries.map((s): AgentIdentityActivityDto => {
        const key = s.actorKeyId ? keyFacts.get(s.actorKeyId) : undefined;
        return {
          actorKind: s.actorKind,
          actorKeyId: s.actorKeyId,
          actorKeyName: key?.name ?? null,
          actorKeyRevoked: key?.revoked ?? null,
          keyLastUsedAt: key?.lastUsedAt ?? null,
          userId: s.userId,
          lastActivityAt: s.lastActivityAt,
          lastTool: s.lastTool,
          lastOutcome: s.lastOutcome,
          lastAllowed: s.lastAllowed,
          calls: s.calls,
          refused: s.refused,
        };
      }),
    };
  }

  /**
   * The reach turned into a `WHERE`, and the one place a caller's own id is
   * pinned.
   *
   * `null` means "provably empty, do not ask the database": it is what a caller
   * without instance reach gets for naming somebody else's `userId`. The answer
   * to "show me what that person's agent did" from somebody who may not know is
   * *there is nothing here*, never "you may not ask" — a refusal on a register
   * confirms the rows exist, which is the thing being withheld.
   *
   * Returning the filter with the asked-for id in it would have been the
   * one-character version of this method and a disclosure: the query would have
   * answered with that person's rows.
   */
  private filterFor(
    reach: ActivityReach,
    user: AuthenticatedUser,
    query: ActivityQuery,
  ): ActivityFilter | null {
    const asked = query.userId;
    if (reach !== 'instance' && asked && asked !== user.userId) return null;
    return {
      userId: reach === 'instance' ? asked : user.userId,
      actorKind: query.actorKind,
      surface: query.surface,
      actorKeyId: query.keyId,
      tool: query.tool,
      outcome: query.outcome,
      allowed:
        query.allowed === undefined ? undefined : query.allowed === 'true',
      operationId: query.operationId,
      since: query.since ? new Date(query.since) : undefined,
      until: query.until ? new Date(query.until) : undefined,
    };
  }

  private async describe(
    user: AuthenticatedUser,
    reach: ActivityReach,
    rows: McpToolCallLogEntity[],
  ): Promise<AgentActivityEntryDto[]> {
    if (!rows.length) return [];
    const keyFacts = await this.keyFacts(
      rows.map((r) => r.actor_key_id).filter((id): id is string => !!id),
    );
    const operations = await this.operationsFor(user, rows);
    const answers = await this.answersBehind(user, operations, rows);
    const verbatim = readsErrorsVerbatim(reach, user);
    return rows.map((row) => {
      const key = row.actor_key_id ? keyFacts.get(row.actor_key_id) : undefined;
      const operation = row.operation_id
        ? (operations.get(row.operation_id) ?? null)
        : null;
      // The row's own column first: a door records the verdict it made, and
      // only a call that came back with an operation id can be asked through
      // the operation instead.
      const grantId = row.grant_id ?? operation?.grantId ?? null;
      const answer = grantId ? answers.get(grantId) : undefined;
      const under = answer?.under ?? null;
      const absent = underAbsentFor(
        {
          allowed: row.allowed,
          outcome: row.outcome,
          operationId: row.operation_id,
          operationVisible: !!operation,
          grantId,
        },
        under,
      );
      const error = discloseRegisterError(row, verbatim);
      return {
        id: row.id,
        at: row.created_at,
        userId: row.user_id,
        tool: row.tool,
        scope: row.scope,
        allowed: row.allowed,
        outcome: row.outcome,
        error: error.text,
        errorWithheld: error.withheld,
        actorKind: row.actor_kind,
        actorKeyId: row.actor_key_id,
        actorKeyName: key?.name ?? null,
        actorKeyRevoked: key?.revoked ?? null,
        // Handed back exactly as stored. `redactToolArgs` decided what this
        // could ever contain, at write time and once; there is no wider copy
        // anywhere for a reader to reach for.
        args: row.args,
        operationId: row.operation_id,
        operation,
        surface: row.surface,
        under,
        underSentence: answer?.sentence ?? null,
        underAbsent: absent,
        underAbsentReason: absent ? UNDER_ABSENT_REASON[absent] : null,
        proposalId: answer?.proposalId ?? null,
        raisedProposalId: row.proposal_id ?? null,
      };
    });
  }

  /**
   * Which answer let each of these operations start, and — when it was a
   * standing one — the words the person read before giving it.
   *
   * The mockup's fourth rule: *the register says under which permission each
   * action happened*, because that is what turns a revoke into an informed
   * decision instead of a change of mind. The guard stamps one column,
   * `grantId`, from `verdict.grantId ?? verdict.proposalId` — so the value is a
   * concession id or a proposal id and the column cannot say which. Resolving
   * it against `agent_concessions` is the only way to tell the two apart, and a
   * miss is therefore read as the one-off approval rather than as "unknown".
   *
   * The sentence is stored verbatim on the concession precisely so a register
   * can show what was agreed to rather than a re-render of a template that may
   * since have changed; it is shown only to the person who gave it, or to
   * somebody who reads the whole instance.
   *
   * The request behind the answer comes out of the same lookup rather than a
   * second one — see {@link proposalBehind} for why it needs no column.
   */
  private async answersBehind(
    user: AuthenticatedUser,
    operations: Map<string, AgentActivityOperationDto>,
    rows: McpToolCallLogEntity[],
  ): Promise<Map<string, AnswerFacts>> {
    const ids = [
      ...new Set(
        [
          ...[...operations.values()].map((o) => o.grantId),
          ...rows.map((r) => r.grant_id),
        ].filter((id): id is string => !!id),
      ),
    ];
    const answers = new Map<string, AnswerFacts>();
    if (!ids.length) return answers;
    const found = await this.concessions.find({ where: { id: In(ids) } });
    const byId = new Map(found.map((c) => [c.id, c]));
    for (const id of ids) {
      const concession = byId.get(id);
      if (!concession) {
        // Not a standing permission, so it was the one-off: "allow once" is
        // spent on the proposal row, and its id is what the guard stamped.
        answers.set(id, {
          under: 'approval',
          sentence: null,
          proposalId: proposalBehind('approval', id, null),
        });
        continue;
      }
      answers.set(id, {
        under: 'concession',
        sentence:
          concession.ownerUserId === user.userId ? concession.sentence : null,
        proposalId: proposalBehind('concession', id, concession.fromProposalId),
      });
    }
    return answers;
  }

  private async keyFacts(ids: string[]): Promise<Map<string, KeyFacts>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.keys.find({
      where: { id: In(unique) },
      select: ['id', 'name', 'revoked', 'lastUsedAt'],
    });
    return new Map(
      rows.map((k) => [
        k.id,
        { name: k.name, revoked: k.revoked, lastUsedAt: k.lastUsedAt ?? null },
      ]),
    );
  }

  /**
   * The operations named by this page, projected, and only those this caller
   * may see.
   *
   * Both gates the direct route applies, asked here because no guard sits on a
   * join: the credential's ceiling first — a key scoped to read the access
   * graph is refused `GET /infrastructure/operations/:id` and must not get the
   * same content sideways — then ownership, resolved once for the whole page
   * instead of once per row. What survives neither is dropped to `null` with
   * the id left in place, which is what a screen needs to say "started
   * something you cannot see" instead of "started nothing".
   */
  private async operationsFor(
    user: AuthenticatedUser,
    rows: McpToolCallLogEntity[],
  ): Promise<Map<string, AgentActivityOperationDto>> {
    const ids = [
      ...new Set(
        rows.map((r) => r.operation_id).filter((id): id is string => !!id),
      ),
    ];
    const found = new Map<string, AgentActivityOperationDto>();
    if (!ids.length) return found;
    if (ceilingWithholds(user, IAM_PERMISSION.APP_READ)) return found;

    const operations = await this.operations.find({ where: { id: In(ids) } });
    const everyOne = await readsEveryOperation(this.policy, user);
    for (const operation of operations) {
      const mine = !!operation.userId && operation.userId === user.userId;
      if (!mine && !everyOne) continue;
      found.set(operation.id, {
        id: operation.id,
        operationType: operation.operationType ?? null,
        status: operation.status,
        progress: operation.progress,
        resourceType: operation.resourceType ?? null,
        resourceName: operation.resourceName ?? null,
        resourceId: operation.resourceId ?? null,
        currentStep: operation.currentStep ?? null,
        startedAt: operation.startedAt ?? null,
        completedAt: operation.completedAt ?? null,
        cancelRequestedAt: operation.cancelRequestedAt ?? null,
        grantId: operation.grantId ?? null,
      });
    }
    return found;
  }
}
