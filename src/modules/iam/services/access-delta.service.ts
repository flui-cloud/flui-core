import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { IdentityRole, UserEntity } from '../../auth/entities/user.entity';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../interfaces/policy-engine.interface';
import {
  IamBinding,
  IamPrincipal,
  IamPrincipalType,
  IamSelector,
  PrincipalAccess,
  ResourceAttributes,
} from '../interfaces/iam.types';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { SectionAccess, sectionLabel } from '../constants/iam-sections';
import {
  AccessDeltaAppDto,
  AccessDeltaCoverage,
  AccessDeltaDto,
  AccessDeltaSectionDto,
  AccessPreviewDto,
} from '../dto/access-delta.dto';

/** Whose access is being changed. */
export interface DeltaTarget {
  type: IamPrincipalType;
  ref: string;
}

/**
 * How many applications a delta names before it stops naming them.
 *
 * A count alone is not a warning — nobody recognises "14 applications", and the
 * whole point is that the person spots the one that matters. A full list is
 * unbounded. Twenty names is where recognition stops paying: past that a reader
 * is scanning, not recognising, and `applicationsLostCount` still carries the
 * exact total.
 */
const NAMED_APPLICATION_CAP = 20;

/**
 * What an access change takes away — computed here, rendered everywhere.
 *
 * It lives in the API and not in the browser on purpose. The same question is
 * asked by three surfaces (the access screen, `flui iam grant …`, an agent
 * holding `mcp:iam:read`), and a derivation written in one of them is a warning
 * the other two cannot give. It is also the only place that *can* answer it
 * correctly: the reachability rule is `PolicyEngine.can`, and reimplementing it
 * beside the engine is how a screen ends up promising a boundary the server
 * does not draw.
 *
 * The method is "resolve before, resolve after, differ", against the real
 * engine both times, so the answer cannot drift from the enforcement. The
 * hypothetical form — resolve against a binding set that does not exist yet —
 * is the same fold (`accessFrom`) over a mutated list, which is what makes it
 * possible to warn *before* rather than to report afterwards.
 *
 * Cost is affordable here for a reason that does not generalise: an access
 * change is a rare, human-paced act, while a permission check is on every
 * request. Materialising the application list is one query on a write path, not
 * work added to a hot read.
 */
@Injectable()
export class AccessDeltaService {
  private readonly logger = new Logger(AccessDeltaService.name);

  constructor(
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  /** The target's access as it stands right now. */
  async resolve(target: DeltaTarget): Promise<PrincipalAccess> {
    const { bindings, isAdmin } = await this.stateOf(target);
    return this.policy.accessFrom(bindings, isAdmin);
  }

  /**
   * The delta around a write that has already happened.
   *
   * `before` is taken by the caller *before* it writes; `after` is resolved
   * here, so what is reported is what the database now says rather than what
   * the caller believed it was doing.
   */
  async since(
    target: DeltaTarget,
    before: PrincipalAccess,
    changed: IamBinding[],
  ): Promise<AccessDeltaDto> {
    return this.diff(target, before, await this.resolve(target), changed);
  }

  /** What removing this one grant would take away from whoever holds it. */
  async previewRevocation(grantId: string): Promise<AccessDeltaDto> {
    const grant = await this.bindings.findOne({ where: { id: grantId } });
    if (!grant) throw new NotFoundException(`Grant ${grantId} not found`);
    return this.preview({
      principalType: grant.principalType,
      principalRef: grant.principalRef,
      removeGrantIds: [grantId],
    });
  }

  /**
   * The general hypothetical: add these bindings, drop those, and say what
   * moves. Nothing is written.
   */
  async preview(dto: AccessPreviewDto): Promise<AccessDeltaDto> {
    const target: DeltaTarget = {
      type: dto.principalType,
      ref: dto.principalRef,
    };
    const { bindings, isAdmin } = await this.stateOf(target);
    const removeIds = new Set(dto.removeGrantIds ?? []);
    const added: IamBinding[] = (dto.add ?? []).map((b) => ({
      role: b.role,
      scopeType: b.scopeType,
      scopeRef: b.scopeRef ?? null,
      selector: (b.selector as IamSelector | undefined) ?? null,
    }));
    const removed = bindings.filter((b) => b.id && removeIds.has(b.id));
    const after = [
      ...bindings.filter((b) => !b.id || !removeIds.has(b.id)),
      ...added,
    ];
    return this.diff(
      target,
      this.policy.accessFrom(bindings, isAdmin),
      this.policy.accessFrom(after, isAdmin),
      [...removed, ...added],
    );
  }

  /** The comparison itself, once both sides are resolved. */
  async diff(
    target: DeltaTarget,
    before: PrincipalAccess,
    after: PrincipalAccess,
    changed: IamBinding[],
  ): Promise<AccessDeltaDto> {
    const sectionsBefore = this.byKey(this.policy.sectionAccessFrom(before));
    const sectionsAfter = this.byKey(this.policy.sectionAccessFrom(after));
    const sectionsClosed: AccessDeltaSectionDto[] = [];
    const sectionsDowngraded: AccessDeltaSectionDto[] = [];
    const sectionsOpened: AccessDeltaSectionDto[] = [];
    for (const [key, from] of sectionsBefore) {
      const to = sectionsAfter.get(key);
      if (!to) sectionsClosed.push({ key, from });
      else if (from === 'full' && to === 'read-only')
        sectionsDowngraded.push({ key, from, to });
    }
    for (const [key, to] of sectionsAfter) {
      if (!sectionsBefore.has(key)) sectionsOpened.push({ key, to });
    }

    const permsBefore = new Set(this.policy.effectivePermissionsFrom(before));
    const permsAfter = new Set(this.policy.effectivePermissionsFrom(after));
    const permissionsLost = [...permsBefore].filter((p) => !permsAfter.has(p));
    const permissionsGained = [...permsAfter].filter(
      (p) => !permsBefore.has(p),
    );

    const reach = await this.applicationReach(before, after);

    const losesNothing =
      sectionsClosed.length === 0 &&
      sectionsDowngraded.length === 0 &&
      permissionsLost.length === 0 &&
      reach.lost.length === 0;
    // Not "no sections left": Home and Settings are gated `always`, so their
    // presence says nothing about access and counting them would mean nobody
    // ever loses everything.
    const losesEverything = permsAfter.size === 0 && !after.isAdmin;

    const coverage = this.coverageOf(changed, reach.known);
    const delta: AccessDeltaDto = {
      principal: { type: target.type, ref: target.ref },
      summary: '',
      losesNothing,
      losesEverything,
      principalIsPlatformAdmin: before.isAdmin,
      sectionsClosed,
      sectionsDowngraded,
      sectionsOpened,
      coverage,
      applicationsLost: reach.lost.slice(0, NAMED_APPLICATION_CAP),
      applicationsLostCount: reach.lost.length,
      applicationsGained: reach.gained.slice(0, NAMED_APPLICATION_CAP),
      applicationsGainedCount: reach.gained.length,
      permissionsLost,
      permissionsGained,
    };
    if (reach.note) delta.note = reach.note;
    delta.summary = this.summarise(delta);
    return delta;
  }

  /**
   * Which applications each side can read.
   *
   * `app:read` is the reachability question and not an arbitrary choice of
   * permission: it is the gate `AppAccessGuard` and `filterReadable` apply, so
   * an application this returns as lost is an application that disappears from
   * the person's list.
   */
  private async applicationReach(
    before: PrincipalAccess,
    after: PrincipalAccess,
  ): Promise<{
    lost: AccessDeltaAppDto[];
    gained: AccessDeltaAppDto[];
    known: boolean;
    note?: string;
  }> {
    let rows: ApplicationEntity[];
    try {
      rows = await this.apps.find({
        where: { deletedAt: IsNull() },
        relations: ['cluster', 'project'],
        order: { name: 'ASC' },
      });
    } catch (error) {
      this.logger.warn(
        `Could not read the application inventory for an access delta: ${
          (error as Error).message
        }`,
      );
      return {
        lost: [],
        gained: [],
        known: false,
        note: 'The application inventory could not be read, so which applications this reaches is not known.',
      };
    }

    const lost: AccessDeltaAppDto[] = [];
    const gained: AccessDeltaAppDto[] = [];
    for (const app of rows) {
      const resource = this.toResource(app);
      const had = this.policy.can(before, IAM_PERMISSION.APP_READ, resource);
      const has = this.policy.can(after, IAM_PERMISSION.APP_READ, resource);
      if (had === has) continue;
      const named: AccessDeltaAppDto = {
        id: app.id,
        name: app.name,
        slug: app.slug,
        clusterName: app.cluster?.name ?? '',
      };
      (had ? lost : gained).push(named);
    }
    return { lost, gained, known: true };
  }

  private toResource(app: ApplicationEntity): ResourceAttributes {
    return {
      slug: app.slug,
      type: app.category as 'system' | 'user',
      kind: app.kind,
      clusterId: app.clusterId,
      clusterName: app.cluster?.name ?? undefined,
      provider: app.cluster?.provider ?? undefined,
      project: app.project?.slug ?? undefined,
      tags: app.tags ?? [],
      owner: app.userId ?? null,
    };
  }

  /**
   * Whether the application lists are the whole truth.
   *
   * A binding that names slugs reaches a fixed set; every other scope is a
   * standing predicate that keeps matching things that do not exist yet, so the
   * list is a snapshot and saying otherwise would be a promise about tomorrow.
   * A section-scoped binding reaches no application at all, so it never makes
   * the answer less exact.
   */
  private coverageOf(
    changed: IamBinding[],
    known: boolean,
  ): AccessDeltaCoverage {
    if (!known) return 'unknown';
    const openEnded = changed.some((b) => {
      if (b.scopeType === 'section') return false;
      if (b.scopeType !== 'selector') return true;
      return !b.selector?.slugs?.length;
    });
    return openEnded ? 'snapshot' : 'exact';
  }

  /**
   * The one sentence. Written here so the three surfaces say the same thing,
   * and short enough that a confirmation dialog, a terminal and a model answer
   * can all carry it whole.
   */
  private summarise(d: AccessDeltaDto): string {
    const who =
      d.principal.type === 'group'
        ? `Group ${d.principal.ref}`
        : d.principal.ref;
    if (d.principalIsPlatformAdmin) {
      return `${who} is a platform admin: their reach comes from that flag, not from these grants, so this changes nothing they can see.`;
    }
    if (d.coverage === 'unknown') {
      return `${who}'s applications could not be listed, so what this takes away is not known. Do not read the empty list as "nothing".`;
    }
    if (d.losesNothing) {
      const gains = this.gainClause(d);
      return gains
        ? `${who} loses nothing — this only adds ${gains}.`
        : `${who} loses nothing, and gains nothing: this changes what they can reach in no way at all.`;
    }
    const parts = this.lossParts(d);
    const tail =
      d.coverage === 'snapshot'
        ? ' — and anything matching that scope from now on'
        : '';
    const everything = d.losesEverything
      ? ' They are left with no access at all.'
      : '';
    return `${who} loses ${parts.join(' and ')}${tail}.${everything}`;
  }

  private lossParts(d: AccessDeltaDto): string[] {
    const parts: string[] = [];
    if (d.applicationsLostCount) {
      const names = d.applicationsLost
        .slice(0, 3)
        .map((a) => a.slug)
        .join(', ');
      const ellipsis = d.applicationsLostCount > 3 ? ', …' : '';
      parts.push(
        d.applicationsLostCount === 1
          ? `1 application (${names})`
          : `${d.applicationsLostCount} applications (${names}${ellipsis})`,
      );
    }
    if (d.sectionsClosed.length) {
      parts.push(
        `the ${d.sectionsClosed.map((s) => sectionLabel(s.key)).join(', ')} section${
          d.sectionsClosed.length === 1 ? '' : 's'
        }`,
      );
    }
    if (d.sectionsDowngraded.length) {
      parts.push(
        `write access to ${d.sectionsDowngraded
          .map((s) => sectionLabel(s.key))
          .join(', ')}`,
      );
    }
    if (!parts.length && d.permissionsLost.length) {
      parts.push(d.permissionsLost.join(', '));
    }
    return parts;
  }

  private gainClause(d: AccessDeltaDto): string {
    const parts: string[] = [];
    if (d.applicationsGainedCount) {
      parts.push(
        `${d.applicationsGainedCount} application${
          d.applicationsGainedCount === 1 ? '' : 's'
        }`,
      );
    }
    if (d.sectionsOpened.length) {
      parts.push(
        `the ${d.sectionsOpened.map((s) => sectionLabel(s.key)).join(', ')} section${
          d.sectionsOpened.length === 1 ? '' : 's'
        }`,
      );
    }
    return parts.join(' and ');
  }

  private byKey(list: SectionAccess[]): Map<string, 'full' | 'read-only'> {
    return new Map(list.map((s) => [s.key as string, s.level]));
  }

  /**
   * The bindings that reach this target, and whether the platform-admin boolean
   * makes the question moot.
   *
   * A user is asked through the engine, so their groups and their
   * service-account bindings come along; a group or a service account is asked
   * directly, because "what does this group buy its members" is the unit a
   * person changes when they touch a group binding.
   */
  private async stateOf(
    target: DeltaTarget,
  ): Promise<{ bindings: IamBinding[]; isAdmin: boolean }> {
    if (target.type === 'user') {
      const row = await this.users.findOne({ where: { email: target.ref } });
      const principal: IamPrincipal = {
        userId: row?.id ?? '',
        email: target.ref,
        role: row?.role ?? IdentityRole.USER,
        isAdmin: false,
      };
      return {
        bindings: await this.policy.bindingsFor(principal),
        isAdmin: !!row?.isAdmin || row?.role === IdentityRole.ADMIN,
      };
    }
    const rows = await this.bindings.find({
      where: { principalType: target.type, principalRef: target.ref },
    });
    return { bindings: rows, isAdmin: false };
  }
}
