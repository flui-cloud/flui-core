import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Not, Repository } from 'typeorm';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../iam/interfaces/policy-engine.interface';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import {
  IamPrincipal,
  IamSelector,
  PrincipalAccess,
  ResourceAttributes,
} from '../iam/interfaces/iam.types';
import { OperatingContextEntryEntity } from './entities/operating-context-entry.entity';
import {
  CONTEXT_SCOPE_TYPES,
  ContextScopeType,
  ENTRY_NATURES,
  EntryNature,
  EntryScope,
  Placement,
  Validity,
  asSelector,
  mayWriteAt,
  needsPlacements,
  reachesReader,
} from './operating-context.core';
import { EntryReach, reachOf } from './operating-context.reach';
import {
  READER_PLACEMENTS,
  ReaderPlacements,
} from './placement/reader-placements';
import {
  CLUSTER_REFERENCES,
  ClusterReferences,
} from './placement/cluster-references';
import {
  advisable,
  appliesTo,
  conflictsAmong,
  needsReview,
  probeAllowedAt,
  validityOf,
} from './operating-context.validity';
import {
  ContextProbeRegistry,
  ProbeCard,
  ProbeExpectationProblem,
  ProbeOp,
  probeCards,
} from './probes/context-probe';
import {
  ENTRY_HANDS,
  EntryHand,
  EntryHands,
  handIsToldTo,
} from './hands/entry-hands';
import {
  ADVISORY_PREAMBLE,
  EntryTextProblem,
  assertSafeEntryText,
} from './safety/entry-safety';
import { selectorForAgent } from './safety/delivered-selector';
import {
  WriteContextEntryDto,
  EditContextEntryDto,
} from './dto/operating-context.dto';

/**
 * Reading the entry requires being able to read the things it is about;
 * writing one requires being able to change them. Two existing permissions, no
 * third one minted — a body of advice that needed its own permission would be
 * the beginning of the second authorization system this feature is forbidden
 * from becoming.
 */
export const CONTEXT_READ = IAM_PERMISSION.APP_READ;
export const CONTEXT_WRITE = IAM_PERMISSION.APP_WRITE;

export interface DeliveredEntry {
  id: string;
  scopeType: string;
  scopeRef?: string | null;
  nature: string;
  topic: string;
  title: string;
  body: string;
  confidence: Validity;
  checkedBy: string;
  updatedAt: Date;
  /**
   * What the note is written on, when it is written on a selection.
   *
   * Null for a `global` or `cluster` note, whose level `scopeType` and
   * `scopeRef` already say in full. Without it a selector note says that it
   * reaches the reader and not *what it is about*, and — because the permissive
   * reach over-approximates — "this rule applies to what you are touching" was
   * a claim nobody had checked.
   */
  selector?: IamSelector | null;
  /** Who this note reaches. Absent from the agent's delivery — see {@link advice}. */
  reaches?: EntryReach;
  /**
   * Who wrote it, when this reader is told — see {@link handIsToldTo}.
   *
   * `null` covers both *you are not told* and *no name is recorded*, and the
   * difference is deliberately not a field: in either case there is no name to
   * show and the honest phrase on the screen is the same one. Never delivered
   * to an agent. A model asked to follow a practice has no use for the name of
   * whoever wrote it — it cannot go and ask them — and would be carrying a
   * person's identity through a channel built to describe resources.
   */
  writtenBy?: EntryHand | null;
  /** Who last put their name to it, on the same terms. */
  confirmedBy?: EntryHand | null;
  /**
   * Who withdrew it, on the same terms, for a note read out of the archive.
   *
   * The question an archived note actually raises is not who wrote it — that
   * is on the note — but who decided it had stopped being true, because that
   * is the person to ask before writing it again. Null on a live note, and
   * null on one retired before the column existed.
   */
  archivedBy?: EntryHand | null;
  /**
   * When it was retired, for a note read out of the archive.
   *
   * Always null on a live note, so one field answers *is this still in force*
   * without a second list having to be consulted to find out.
   */
  archivedAt?: Date | null;
}

/**
 * A delivered entry as an agent is handed it: the reach line off, the selector
 * narrowed to the axes that describe resources — see {@link selectorForAgent}.
 */
export type AdviceEntry = Omit<DeliveredEntry, 'reaches' | 'selector'> & {
  selector?: IamSelector | null;
  pinnedToAnOwner?: boolean;
};

/**
 * What one reader may be told about the hands on a batch of notes.
 *
 * Carried rather than re-derived per entry so that the directory is read once
 * per request: {@link OperatingContextService.telling} decides who is told and
 * resolves exactly those names.
 */
interface Telling {
  access: PrincipalAccess;
  readerUserId: string;
  names: Map<string, string>;
}

export interface ContextDelivery {
  preamble: string;
  advice: AdviceEntry[];
  needsReview: AdviceEntry[];
  conflicts: Array<{ topic: string; entryIds: string[] }>;
}

@Injectable()
export class OperatingContextService {
  private readonly logger = new Logger(OperatingContextService.name);

  constructor(
    @InjectRepository(OperatingContextEntryEntity)
    private readonly entries: Repository<OperatingContextEntryEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    private readonly probes: ContextProbeRegistry,
    @Inject(READER_PLACEMENTS) private readonly placements: ReaderPlacements,
    @Inject(ENTRY_HANDS) private readonly hands: EntryHands,
    @Inject(CLUSTER_REFERENCES)
    private readonly clusterRefs: ClusterReferences,
  ) {}

  /**
   * Everything this principal may see, with each entry's own verdict on itself.
   *
   * The reachability filter runs in memory against one resolved access, the way
   * the application list already does: the alternative — a WHERE clause that
   * encoded the grant model — would be the second copy of the boundary.
   */
  async list(
    principal: IamPrincipal,
    focus?: ResourceAttributes,
  ): Promise<DeliveredEntry[]> {
    return this.deliverAll(principal, { archivedAt: IsNull() }, focus);
  }

  /**
   * The notes that were retired, to whoever the note reached while it stood.
   *
   * `DELETE` archives rather than deletes — *a rule that was true once explains
   * a decision that was made once* — and until this route existed nothing ever
   * read `archivedAt` back. An archive nobody can open is deletion with extra
   * steps, and worse than deletion: it looks like history was kept.
   *
   * Three properties, and each one is the reason it is a route of its own
   * rather than a flag on the list:
   *
   *  - **it is never advice.** {@link advice} is built on {@link list}, so a
   *    retired note cannot reach an agent by any path. What has been withdrawn
   *    must not come back as guidance;
   *  - **its premise is not re-asked.** {@link deliver} leaves an archived
   *    note's last probe answer exactly as it stood, so the archive records
   *    what was believed when the note was retired instead of quietly
   *    re-litigating it against a world that has moved on;
   *  - **archiving changes nobody's reach.** The same filter as the live list,
   *    so retiring a note neither hides it from somebody who could read it nor
   *    shows it to somebody who could not.
   */
  async retired(
    principal: IamPrincipal,
    focus?: ResourceAttributes,
  ): Promise<DeliveredEntry[]> {
    return this.deliverAll(principal, { archivedAt: Not(IsNull()) }, focus);
  }

  private async deliverAll(
    principal: IamPrincipal,
    where: FindOptionsWhere<OperatingContextEntryEntity>,
    focus?: ResourceAttributes,
  ): Promise<DeliveredEntry[]> {
    const [access, rows] = await Promise.all([
      this.policy.resolveAccess(principal),
      this.entries.find({ where }),
    ]);
    const placements = await this.whereTheirWorkSits(access, rows);
    const reachable = rows.filter(
      (e) =>
        this.reaches(access, e, placements) &&
        (!focus || appliesTo(scopeOf(e), focus)),
    );
    const ctx = await this.telling(principal, access, reachable);
    return Promise.all(reachable.map((e) => this.deliver(e, ctx)));
  }

  /**
   * Where this reader's resources actually sit, or `null` when it does not
   * matter or cannot be told.
   *
   * Asked only of the entries that name a place, and only when a grant leaves
   * that axis open — {@link needsPlacements} is the whole of that condition, so
   * the ordinary reader still costs exactly one query. A failure here is `null`
   * and never an empty list: an inventory that cannot be read must widen the
   * answer back to what it was, not quietly withhold the local practice.
   */
  private async whereTheirWorkSits(
    access: PrincipalAccess,
    rows: OperatingContextEntryEntity[],
  ): Promise<Placement[] | null> {
    const descending = rows
      .filter((e) => e.nature === 'practice')
      .map((e) => asSelector(scopeOf(e)));
    if (!needsPlacements(access, descending, CONTEXT_READ)) return null;
    try {
      return await this.placements.placementsOf(access, CONTEXT_READ);
    } catch (e) {
      this.logger.warn(`could not locate the reader's resources: ${e}`);
      return null;
    }
  }

  /**
   * The seed of the delivery towards an agent.
   *
   * Not a tool and not a skill — those are the next step, and building them
   * here would give a model two channels telling it how to behave. What it is
   * is the shape that consumer needs: advice separated from what is asking to
   * be revisited, conflicts named rather than silently resolved, and a preamble
   * that says out loud these are notes, not orders.
   */
  async advice(
    principal: IamPrincipal,
    focus?: ResourceAttributes,
  ): Promise<ContextDelivery> {
    const all = await this.list(principal, focus);
    const advice = all.filter((e) => advisable(e.confidence));
    return {
      preamble: ADVISORY_PREAMBLE,
      advice: advice.map(forAgent),
      needsReview: all.filter((e) => needsReview(e.confidence)).map(forAgent),
      // Asked of the advice, not of everything: a broken entry is not a
      // disagreement with a live one, it is a premise that failed, and pairing
      // the two would bury the second signal under the first.
      conflicts: conflictsAmong(
        advice.map((e) => ({
          id: e.id,
          topic: e.topic,
          scopeType: e.scopeType,
          scopeRef: e.scopeRef,
        })),
      ),
    };
  }

  async create(
    principal: IamPrincipal,
    dto: WriteContextEntryDto,
  ): Promise<DeliveredEntry> {
    const scope = await this.canonical(scopeFromDto(dto));
    const access = await this.assertMayWrite(principal, scope);
    this.assertWellFormed(dto, scope);
    const probeExpected =
      dto.checkKind === 'probe' ? this.interpretPremise(dto) : null;
    const saved = await this.entries.save(
      this.entries.create({
        ...scope,
        nature: dto.nature,
        topic: dto.topic,
        title: dto.title,
        body: dto.body,
        checkKind: dto.checkKind ?? 'none',
        probeId: dto.probeId ?? null,
        probeParams: dto.probeParams ?? null,
        probeOp: dto.probeOp ?? null,
        probeExpected,
        validForDays: dto.validForDays ?? null,
        confirmedAt: dto.checkKind === 'attestation' ? new Date() : null,
        confirmedByUserId:
          dto.checkKind === 'attestation' ? principal.userId : null,
        authorUserId: principal.userId,
      }),
    );
    return this.deliver(saved, await this.telling(principal, access, [saved]));
  }

  async edit(
    principal: IamPrincipal,
    id: string,
    dto: EditContextEntryDto,
  ): Promise<DeliveredEntry> {
    const { entry, access } = await this.own(principal, id);
    const next = {
      title: dto.title ?? entry.title,
      body: dto.body ?? entry.body,
      topic: dto.topic ?? entry.topic,
    };
    this.assertSafeText(next);
    Object.assign(entry, next);
    const saved = await this.entries.save(entry);
    return this.deliver(saved, await this.telling(principal, access, [saved]));
  }

  /**
   * A person putting their name to the entry again.
   *
   * The only thing that moves an attestation back to `checked`, and it
   * deliberately does nothing for a probe-checked entry: signing a claim the
   * platform has already contradicted would be a way to silence the one signal
   * here that is not an opinion.
   */
  async confirm(principal: IamPrincipal, id: string): Promise<DeliveredEntry> {
    const { entry, access } = await this.own(principal, id);
    if (entry.checkKind !== 'attestation') {
      throw new BadRequestException(
        'Only an attested note is confirmed by a person; a probed one is confirmed by the platform.',
      );
    }
    entry.confirmedAt = new Date();
    entry.confirmedByUserId = principal.userId;
    const saved = await this.entries.save(entry);
    return this.deliver(saved, await this.telling(principal, access, [saved]));
  }

  async archive(principal: IamPrincipal, id: string): Promise<void> {
    const { entry } = await this.own(principal, id);
    entry.archivedAt = new Date();
    entry.archivedByUserId = principal.userId;
    await this.entries.save(entry);
  }

  /**
   * What an author may lean on when writing an entry, and what each one wants.
   *
   * The parameters are here because the write refuses a premise it cannot
   * check — an unregistered probe, a parameter set the probe will not answer,
   * a value unreadable in the type the question answers — and a catalogue that
   * published only a name and a sentence left a form no way to know that
   * `app.field` wants a `slug`. That was a refusal the author could not have
   * avoided, which is the same defect as a note that accuses itself: found out
   * after pressing save, either way.
   *
   * Derived from the probes rather than written out here: see
   * {@link probeCards}. Nothing about the installation's own state is
   * published — the names of the fields a note may lean on, which `describes`
   * has always said, and the type each answers in.
   */
  probeCatalog(): ProbeCard[] {
    return probeCards(this.probes.list());
  }

  /**
   * The line that says who a note at this level would reach, before it exists.
   *
   * A read and not a filter: it refuses nothing, and the answer is the same one
   * a saved note carries, so the form, the CLI and the re-reading cannot end up
   * describing the same level in three different ways.
   */
  reachFor(
    scopeType: string,
    nature: string,
    scopeRef?: string | null,
  ): EntryReach {
    if (!isScopeType(scopeType)) {
      throw new BadRequestException(
        `A level is one of ${CONTEXT_SCOPE_TYPES.join(', ')}.`,
      );
    }
    if (!isNature(nature)) {
      throw new BadRequestException(
        `A note is one of ${ENTRY_NATURES.join(', ')}.`,
      );
    }
    if (scopeType === 'cluster' && !scopeRef) {
      throw new BadRequestException('A cluster note names its cluster.');
    }
    return reachOf({ scopeType, scopeRef: scopeRef ?? null }, nature);
  }

  private reaches(
    access: PrincipalAccess,
    e: OperatingContextEntryEntity,
    placements: Placement[] | null,
  ): boolean {
    return reachesReader(
      access,
      {
        scope: scopeOf(e),
        nature: e.nature,
        permission: CONTEXT_READ,
      },
      placements,
    );
  }

  /**
   * The entry with its premise re-asked, and the answer written back only when
   * it changed.
   */
  private async deliver(
    e: OperatingContextEntryEntity,
    told: Telling,
  ): Promise<DeliveredEntry> {
    let status = e.lastProbeStatus ?? null;
    // Never re-asked for a retired note: the archive says what was believed
    // when the note was withdrawn, and re-running the probe would rewrite that
    // record against a world that has moved on since.
    if (e.checkKind === 'probe' && !e.archivedAt) {
      const outcome = await this.probes.evaluate(
        e.probeId,
        e.probeParams,
        e.probeOp,
        e.probeExpected,
      );
      status = outcome.status;
      if (outcome.status !== e.lastProbeStatus) {
        e.lastProbeStatus = outcome.status;
        e.lastProbeAt = new Date();
        e.lastProbeDetail = outcome.detail;
        await this.entries
          .save(e)
          .catch((err) =>
            this.logger.warn(`could not record probe outcome: ${err}`),
          );
      }
    }
    const confidence = validityOf(
      {
        checkKind: e.checkKind,
        confirmedAt: e.confirmedAt,
        validForDays: e.validForDays,
        lastProbeStatus: status,
      },
      new Date(),
    );
    return {
      id: e.id,
      scopeType: e.scopeType,
      scopeRef: e.scopeRef,
      nature: e.nature,
      topic: e.topic,
      title: e.title,
      body: e.body,
      confidence,
      checkedBy: e.checkKind,
      updatedAt: e.updatedAt,
      selector: e.selector ?? null,
      reaches: reachOf(scopeOf(e), e.nature),
      writtenBy: this.handOf(e, e.authorUserId, told),
      confirmedBy: this.handOf(e, e.confirmedByUserId, told),
      archivedBy: this.handOf(e, e.archivedByUserId, told),
      archivedAt: e.archivedAt ?? null,
    };
  }

  /**
   * Whose ids this reader is entitled to see a name for, resolved in one query.
   *
   * The gate runs before the lookup and not after it, so a name this reader is
   * not told is never read out of the directory at all — the cheapest way to be
   * sure it cannot be delivered by a later mistake.
   */
  private async telling(
    principal: IamPrincipal,
    access: PrincipalAccess,
    rows: OperatingContextEntryEntity[],
  ): Promise<Telling> {
    const wanted: string[] = [];
    for (const e of rows) {
      for (const hand of [
        e.authorUserId,
        e.confirmedByUserId,
        e.archivedByUserId,
      ]) {
        if (this.isTold(access, e, principal.userId, hand)) wanted.push(hand!);
      }
    }
    return {
      access,
      readerUserId: principal.userId,
      names: await this.hands.namesOf(wanted),
    };
  }

  private handOf(
    e: OperatingContextEntryEntity,
    hand: string | null | undefined,
    told: Telling,
  ): EntryHand | null {
    if (!this.isTold(told.access, e, told.readerUserId, hand)) return null;
    return {
      name: told.names.get(hand!) ?? null,
      isYou: hand === told.readerUserId,
    };
  }

  private isTold(
    access: PrincipalAccess,
    e: OperatingContextEntryEntity,
    readerUserId: string | null | undefined,
    hand: string | null | undefined,
  ): boolean {
    if (!hand) return false;
    return handIsToldTo(access, scopeOf(e), CONTEXT_READ, readerUserId, hand);
  }

  private async own(
    principal: IamPrincipal,
    id: string,
  ): Promise<{ entry: OperatingContextEntryEntity; access: PrincipalAccess }> {
    const entry = await this.entries.findOne({ where: { id } });
    if (!entry || entry.archivedAt) throw new NotFoundException();
    const access = await this.assertMayWrite(principal, scopeOf(entry));
    return { entry, access };
  }

  /** Returns the access it resolved, so no write path resolves it twice. */
  private async assertMayWrite(
    principal: IamPrincipal,
    scope: EntryScope,
  ): Promise<PrincipalAccess> {
    const access = await this.policy.resolveAccess(principal);
    if (!mayWriteAt(access, scope, CONTEXT_WRITE)) {
      throw new ForbiddenException(
        'Writing a note at this level needs a grant that covers the whole of it.',
      );
    }
    return access;
  }

  /**
   * The premise, read in the type its probe answers, or a refusal.
   *
   * At the centre and not in each client, which is the whole of decision 166:
   * a form posts strings, and a `"3"` stored next to a `nodeCount` of `3` makes
   * the note declare itself broken for a reason that was never true. The
   * dashboard had solved it for itself; the CLI, an MCP tool and a direct call
   * had not, and every one of them writes this same premise.
   */
  private interpretPremise(dto: WriteContextEntryDto): unknown {
    try {
      return this.probes.interpret(
        dto.probeId,
        dto.probeParams,
        dto.probeOp as ProbeOp,
        dto.probeExpected,
      );
    } catch (e) {
      if (e instanceof ProbeExpectationProblem) {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }

  /**
   * One spelling per cluster, decided before anything else reads the scope.
   *
   * Every rule about who reads a cluster note compares `scopeRef` against
   * another string, so a cluster recorded once by id and once by name produces
   * two sets of notes that cannot see each other — which is what the live
   * instance had: `f94b9c06-…` from the dashboard and `control-cluster` from a
   * terminal, about the same one node.
   *
   * Resolved before {@link assertMayWrite}, deliberately: the permission check
   * matches the grant's selector against this same reference, so a name that
   * reached it unresolved would be asking the boundary a question about a
   * string rather than about a cluster.
   */
  private async canonical(scope: EntryScope): Promise<EntryScope> {
    if (scope.scopeType !== 'cluster' || !scope.scopeRef) return scope;
    const id = await this.clusterRefs.canonicalIdOf(scope.scopeRef);
    if (!id) {
      throw new BadRequestException(
        `No cluster here answers to “${scope.scopeRef}”.`,
      );
    }
    return { ...scope, scopeRef: id };
  }

  private assertWellFormed(dto: WriteContextEntryDto, scope: EntryScope): void {
    if (scope.scopeType === 'cluster' && !scope.scopeRef) {
      throw new BadRequestException('A cluster note names its cluster.');
    }
    if (scope.scopeType === 'selector' && !scope.selector) {
      throw new BadRequestException('A selector note carries its selector.');
    }
    if (dto.checkKind === 'probe') {
      if (!probeAllowedAt(scope)) {
        throw new BadRequestException(
          'A global note cannot be compared with anything: it is either an intention (write it as prose or attest it) or it belongs at a narrower level.',
        );
      }
      if (!dto.probeId || !dto.probeOp) {
        throw new BadRequestException(
          'A probed note names a probe and a comparison.',
        );
      }
    }
    if (dto.checkKind === 'attestation' && !dto.validForDays) {
      throw new BadRequestException(
        'An attested note says how long the confirmation is worth.',
      );
    }
    this.assertSafeText(dto);
  }

  private assertSafeText(text: {
    title: string;
    body: string;
    topic: string;
  }): void {
    try {
      assertSafeEntryText(text);
    } catch (e) {
      if (e instanceof EntryTextProblem)
        throw new BadRequestException(e.message);
      throw e;
    }
  }
}

/**
 * Named field by field rather than subtracted, in the same shape the probe
 * registry names what it will answer over: what a model is handed is an
 * allow-list, so a field added to the delivery has to be put here on purpose
 * instead of arriving in an agent's context because nobody stopped it.
 *
 * Two fields are decided here rather than copied. The reach line is dropped: it
 * is written for whoever is about to save a note or read one back, and a model
 * told a second time, per entry, who else can see it spends context on a
 * question it was not asked. The selector is narrowed instead of dropped,
 * because *what a note is about* is the one thing an agent has to know before
 * leaning on it — with the axis that names a principal left out.
 *
 * Two more never appear below, for the same reason `owner` is stripped out of
 * the selector: `writtenBy` and `confirmedBy` name **people**. A model cannot
 * go and ask them, so the name buys it nothing, and a delivery built to
 * describe resources would be carrying somebody's identity into a context that
 * gets logged, replayed and quoted back. Whose hand it was is a question for
 * the person reading the screen.
 */
function forAgent(e: DeliveredEntry): AdviceEntry {
  const seen = selectorForAgent(e.selector);
  return {
    id: e.id,
    scopeType: e.scopeType,
    scopeRef: e.scopeRef,
    nature: e.nature,
    topic: e.topic,
    title: e.title,
    body: e.body,
    confidence: e.confidence,
    checkedBy: e.checkedBy,
    updatedAt: e.updatedAt,
    selector: seen.selector,
    pinnedToAnOwner: seen.pinnedToAnOwner,
  };
}

const isScopeType = (v: string): v is ContextScopeType =>
  (CONTEXT_SCOPE_TYPES as readonly string[]).includes(v);

const isNature = (v: string): v is EntryNature =>
  (ENTRY_NATURES as readonly string[]).includes(v);

function scopeOf(e: OperatingContextEntryEntity): EntryScope {
  return {
    scopeType: e.scopeType,
    scopeRef: e.scopeRef,
    selector: e.selector,
  };
}

function scopeFromDto(dto: WriteContextEntryDto): EntryScope {
  return {
    scopeType: dto.scopeType,
    scopeRef: dto.scopeRef ?? null,
    selector: dto.selector ?? null,
  };
}
