/**
 * The apply: a map that was only read becomes a deploy that actually runs,
 * without touching the branch the author works on.
 *
 * The shape, and why it is this shape.
 *
 * **Flui cuts its own branch.** `flui/deploy-<baseSha7>`, at the exact commit
 * the map was read from — not at the tip of the author's branch, which may
 * have moved since. Their branch never moves. If the build goes green they
 * promote; if it does not, a branch is thrown away and nothing happened. The
 * name carries the commit it came from rather than a timestamp, so it is
 * readable and deterministic — and `createRef` answering 422 is then the lock:
 * two applies from the same commit cannot both proceed.
 *
 * **One commit, N files.** All the rendered `flui.yaml` and all the generated
 * workflows land in a single tree. That commit is what starts the builds —
 * the workflows trigger on `push` to this very branch — so N commits would
 * mean N rounds of builds racing each other.
 *
 * **The applications exist before the commit.** A generated workflow carries
 * `FLUI_APP_ID`, so the application has to exist to generate the file. Nothing
 * is written to GitHub while they are being created: if unit 3 of 5 fails,
 * Flui deletes the branch it cut and the author's *repository* is exactly as
 * it was. Their *applications* are not: units 1 and 2 exist, and so do the
 * databases their manifests asked for. Flui says so instead of deleting them —
 * see `strandedFailure` for why that is the rule and not a shortcut.
 *
 * **The identity keeps the two apart.** A manifest deploy is identified by
 * (cluster, repository, branch, name) — `findExistingApp` in
 * `application-source-deploy.service.ts` compares exactly those four. The
 * branch here is `flui/…`, so an apply can never upsert onto the production
 * application of the same repository. That property is the whole reason this
 * is safe, and it is a property of that comparison, not of this file.
 */

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import {
  ApplicationSourceDeployService,
  type PreparedApplicationFromYaml,
} from '../../applications/services/application-source-deploy.service';
import { ApplicationWorkflowService } from '../../applications/services/application-workflow.service';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import {
  ATTACHED_SERVICES_PORT,
  type AttachedServicesPort,
} from '../../applications/interfaces/attached-services.port';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import {
  CommitFile,
  GitHubWorkflowService,
  fluiWorkflowFileName,
} from './github-workflow.service';
import { WorkflowGeneratorService } from './workflow-generator.service';
import { RepoMapService } from './repo-map.service';
import type { RepositoryMapResponseDto } from '../dto/repository-map.dto';
import {
  AppliedUnitDto,
  RepositoryApplyResponseDto,
} from '../dto/repository-apply.dto';

/**
 * The verdicts an apply refuses to act on. `blocked` and
 * `insufficient_capacity` are statements that a deploy would not work;
 * `not_assessed` is a statement that nobody looked. Applying on any of the
 * three would spend the author's Actions minutes to reach a conclusion the
 * map already reached for free.
 */
const REFUSED_VERDICTS = new Set([
  'blocked',
  'insufficient_capacity',
  'not_assessed',
]);

/** A unit is worth spending someone's Actions minutes on only in these two states. The renderer
 * skips a unit for its own reasons (no port, template build) but renders one that the verdict
 * calls `blocked` — a docker socket, `privileged`, a build that wants secrets — so filtering on
 * the render alone commits and builds a unit the map already said would not work. */
const APPLIABLE_READINESS = new Set([
  'deployable',
  'deployable_pending_inputs',
]);

/**
 * Where an apply records, on the application itself, that it left it behind.
 *
 * It has to live on the row because the branch is part of a manifest deploy's
 * identity: an application prepared on `flui/deploy-<A7>` and abandoned there
 * is invisible to an apply from commit B, which would happily create a second
 * one — and a second database — next to it. This mark is the only thing that
 * connects the two attempts.
 */
export const STRANDED_APPLY_KEY = 'flui.apply.stranded';

/** What the mark says, verbatim, for whoever reads the row next. */
export interface StrandedApplyMark {
  at: string;
  branch: string;
  unitId: string;
  reason: string;
  /** `name=block`, the services that already exist because of this row. */
  services: string[];
}

/** One unit's application, created but not yet written to GitHub. */
interface PreparedEntry {
  unit: RenderedUnitRef;
  result: PreparedApplicationFromYaml;
  workflowFileName: string;
}

export interface RepoApplyRequest {
  repositoryId: string;
  owner: string;
  repo: string;
  /** The author's branch: read from, cut from, never written to. */
  branch: string;
  clusterId: string;
  unitIds?: string[];
  isSandboxGuest: boolean;
}

@Injectable()
export class RepoApplyService {
  private readonly logger = new Logger(RepoApplyService.name);

  constructor(
    private readonly repoMapService: RepoMapService,
    private readonly githubWorkflowService: GitHubWorkflowService,
    private readonly workflowGenerator: WorkflowGeneratorService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => ApplicationSourceDeployService))
    private readonly sourceDeploy: ApplicationSourceDeployService,
    @Inject(forwardRef(() => ApplicationWorkflowService))
    private readonly applicationWorkflow: ApplicationWorkflowService,
    private readonly applicationsRepository: ApplicationsRepository,
    @Inject(ATTACHED_SERVICES_PORT)
    private readonly attachedServices?: AttachedServicesPort,
  ) {}

  async apply(
    userId: string,
    userEmail: string,
    request: RepoApplyRequest,
  ): Promise<RepositoryApplyResponseDto> {
    // A guest on a shared demo is a stranger to the repository owner. A branch
    // is milder than a push — it moves nothing of theirs — but it still leaves
    // a ref and still spends their Actions minutes, and a stranger clicking a
    // button in our interface is not the owner's consent. The one-app path
    // downgrades a guest to a pull request; this path has nothing to downgrade
    // to, because a pull request per unit is not what the apply is.
    if (request.isSandboxGuest) {
      throw new ForbiddenException(
        'Applying a repository map writes a branch and starts builds in a real GitHub repository, ' +
          'which the sandbox does not do on a guest’s behalf. Connect this repository to your own ' +
          'Flui installation to apply it.',
      );
    }

    const repoFullName = `${request.owner}/${request.repo}`;
    const map = await this.repoMapService.mapFor(userId, {
      owner: request.owner,
      repo: request.repo,
      ref: request.branch,
      repositoryId: request.repositoryId,
      clusterId: request.clusterId,
    });

    const units = this.selectUnits(map, request, repoFullName);
    const baseSha = map.read.commitSha;
    // Everything downstream is named after this commit and claims to have been
    // rendered from it. Without it there is nothing true to name, and falling
    // back to "wherever the branch points now" would make the branch name and
    // `baseCommitSha` two assertions nobody checked.
    if (!baseSha) {
      throw new UnprocessableEntityException(
        `The map of ${repoFullName}@${request.branch} did not record the commit it read, ` +
          'so an apply cannot state which commit it deployed. Nothing was written to the repository. ' +
          'Read the map again and apply from that.',
      );
    }
    const head = `flui/deploy-${baseSha.slice(0, 7)}`;

    // The first write, and the cheapest one there is: a ref pointing at the
    // commit the map already read. No file changed, no workflow matched, no
    // minute spent — so a credential without write access fails here, before
    // an Application row exists.
    await this.githubWorkflowService.createBranchFrom(
      userId,
      request.owner,
      request.repo,
      head,
      baseSha,
    );

    // Whether the one commit landed. It is the line the rollback must not
    // cross: before it, the branch is an empty ref and deleting it undoes the
    // whole attempt; after it, the branch holds a commit and N builds are
    // already running on the author's Actions minutes, and deleting it would
    // destroy the record of work that really happened.
    const landed = { committed: false };
    // The applications that already exist when something goes wrong. Held out
    // here, not inside `applyOnBranch`, because the rollback is the only place
    // that can name them — and naming them is all the rollback is allowed to
    // do (see `strandedFailure`).
    const prepared: PreparedEntry[] = [];

    try {
      return await this.applyOnBranch({
        userId,
        userEmail,
        request,
        repoFullName,
        map,
        units,
        head,
        baseSha,
        landed,
        prepared,
      });
    } catch (error) {
      if (!landed.committed) {
        // An empty ref pointing at the base. Removing it means a retry is not
        // blocked by the lock of an attempt that never got anywhere.
        // The answer is used, not assumed. `branchDeleted: true` used to be written flat, and when
        // the deletion failed the next retry from the same commit met a 409 that spoke of "an
        // earlier apply" holding a branch that is in fact empty — a confusing refusal on top of a
        // false report.
        const branchDeleted = await this.githubWorkflowService.deleteBranch(
          userId,
          request.owner,
          request.repo,
          head,
        );
        if (prepared.length > 0) {
          throw await this.strandedFailure(error, {
            prepared,
            head,
            branchDeleted,
            repoFullName,
            clusterId: request.clusterId,
          });
        }
      } else {
        this.logger.error(
          `Apply of ${repoFullName} failed after the commit landed on ${head}. ` +
            'The branch and its builds are left in place — deleting them would destroy work that is already running.',
        );
      }
      throw error;
    }
  }

  /**
   * Everything after the branch exists: create the applications, write the two
   * repository secrets, land one commit, then mark what the commit started.
   */
  private async applyOnBranch(ctx: {
    userId: string;
    userEmail: string;
    request: RepoApplyRequest;
    repoFullName: string;
    map: RepositoryMapResponseDto;
    units: RenderedUnitRef[];
    head: string;
    baseSha: string;
    /** Flipped the instant the commit lands — see the rollback in `apply`. */
    landed: { committed: boolean };
    /**
     * Filled as each application is prepared, so the rollback in `apply` can
     * name what already exists. Prepared, not deployed: the Application rows
     * and their attached services exist; not one byte has been written to
     * GitHub yet.
     */
    prepared: PreparedEntry[];
  }): Promise<RepositoryApplyResponseDto> {
    const { userId, request, head, prepared } = ctx;
    const backendPollingOnly = this.applicationWorkflow.isBackendPollingOnly();

    await this.prepareUnits(ctx);

    const webhookToken = await this.ensureRepositorySecrets(
      userId,
      request,
      backendPollingOnly,
    );

    const files = this.buildCommitFiles(
      prepared,
      head,
      request,
      backendPollingOnly,
    );

    const commit = await this.githubWorkflowService.commitFilesOnBranch(
      userId,
      request.owner,
      request.repo,
      head,
      files,
      {
        message:
          prepared.length === 1
            ? `chore(flui): deploy ${prepared[0].result.app.name}`
            : `chore(flui): deploy ${prepared.length} applications`,
      },
    );
    ctx.landed.committed = true;

    // Only now. An application marked AWAITING_BUILD next to a commit that
    // failed to land is a spinner for a build that will never start, and the
    // watchdog turns it into a FAILED half an hour later; an application still
    // PENDING next to no commit is visibly unfinished and recoverable.
    //
    // Per unit, and per unit it may fail. Past the commit there is no failure
    // left worth throwing on: the builds of every unit are already running, so
    // an exception here would hide the branch, the commit and the units that
    // ARE armed behind a 500 — and the caller would have no way to learn that
    // unit 4 is the one that answers its webhook with a 401.
    const applied = await this.markAppliedUnits(
      ctx,
      prepared,
      commit,
      webhookToken,
    );

    const unarmed = applied.filter((u) => !u.armed);
    this.logger.log(
      `Applied ${applied.length} unit(s) of ${ctx.repoFullName} on ${head} (${commit.sha.slice(0, 7)})` +
        (unarmed.length > 0
          ? ` — ${unarmed.length} not armed: ${quoteAll(unarmed.map((u) => u.slug))}`
          : ''),
    );

    return {
      partial: unarmed.length > 0,
      repositoryId: request.repositoryId,
      repoFullName: ctx.repoFullName,
      baseBranch: request.branch,
      baseCommitSha: ctx.baseSha,
      branch: head,
      branchUrl: `https://github.com/${ctx.repoFullName}/tree/${head}`,
      commitSha: commit.sha,
      commitUrl: `https://github.com/${ctx.repoFullName}/commit/${commit.sha}`,
      files: commit.files,
      units: applied,
      skipped: ctx.map.render?.skipped ?? [],
      verdict: ctx.map.verdict.outcome,
      verdictReason: ctx.map.verdict.reason,
    };
  }

  /**
   * Applications an earlier attempt left behind. Reusing one is what stops a
   * retry from creating a second application — and a second database — beside
   * the first: the branch is part of an application's identity, so an attempt
   * stranded on `flui/deploy-<A7>` is invisible to an apply from commit B.
   */
  private async prepareUnits(ctx: {
    userId: string;
    userEmail: string;
    request: RepoApplyRequest;
    repoFullName: string;
    units: RenderedUnitRef[];
    head: string;
    prepared: PreparedEntry[];
  }): Promise<void> {
    const strandedByName = await this.strandedApplications(ctx.request);

    for (const unit of ctx.units) {
      const reuse = strandedByName.get(unit.name);
      try {
        const result = await this.sourceDeploy.prepareApplicationFromYaml(
          ctx.userId,
          {
            yaml: unit.yaml,
            clusterId: ctx.request.clusterId,
            repoFullName: ctx.repoFullName,
            // The branch Flui cut — this is what makes the applied application a
            // distinct one rather than an upsert onto production.
            branch: ctx.head,
          },
          ctx.userEmail,
          reuse ? { adoptApplicationId: reuse.id } : undefined,
        );
        ctx.prepared.push({
          unit,
          result,
          workflowFileName: fluiWorkflowFileName(result.app.slug),
        });
      } catch (error) {
        // The unit that fails is the one most likely to have left something behind, and it used to
        // be the only one nobody could name. `prepareApplicationFromYaml` writes the Application
        // row before it provisions the services, and provisioning is the step most likely to fail
        // — so a failure here can leave a row that already owns a running database, while the
        // rollback below only knew about the units that had *returned*. It was not in the error,
        // it was not marked for reuse, and the next apply — reading a different branch — created a
        // second application with a second database beside it, for as long as anyone kept trying.
        const orphan = await this.applicationLeftBy(
          ctx.request,
          ctx.head,
          unit.name,
        );
        if (orphan) {
          ctx.prepared.push({
            unit,
            result: orphan,
            workflowFileName: fluiWorkflowFileName(orphan.app.slug),
          });
        }
        throw error;
      }
    }
  }

  /**
   * One credential for the whole repository, and it must be the one the repository ALREADY has.
   *
   * `FLUI_WEBHOOK_TOKEN` is a *repository* secret, and every application of that repository is
   * checked against it. Minting a fresh one here and storing it on only the N new applications
   * rotated the secret out from under any application already deploying from this repository —
   * its next push would carry the new token, the webhook would answer 401, and its auto-deploy
   * would stop without saying anything, because the build watcher only reconciles applications
   * that are AWAITING_BUILD. So: reuse what is there, and mint only when nothing holds one.
   */
  private async ensureRepositorySecrets(
    userId: string,
    request: RepoApplyRequest,
    backendPollingOnly: boolean,
  ): Promise<string> {
    const existingToken =
      await this.applicationsRepository.findWebhookTokenForRepository(
        request.repositoryId,
      );
    const webhookToken = existingToken ?? uuidv4();
    if (!backendPollingOnly && !existingToken) {
      await this.applicationWorkflow.saveWebhookSecret(
        userId,
        request.owner,
        request.repo,
        webhookToken,
      );
    }
    await this.applicationWorkflow.saveFluiGhcrSecret(
      userId,
      request.owner,
      request.repo,
    );
    return webhookToken;
  }

  private buildCommitFiles(
    prepared: PreparedEntry[],
    head: string,
    request: RepoApplyRequest,
    backendPollingOnly: boolean,
  ): CommitFile[] {
    const baseUrl = this.configService.get<string>('WEBHOOK_BASE_URL') ?? '';
    const files: CommitFile[] = [];
    for (const entry of prepared) {
      files.push(
        {
          path: manifestPathFor(entry.unit.unitId),
          content: entry.unit.yaml,
        },
        {
          path: `.github/workflows/${entry.workflowFileName}`,
          content: this.workflowGenerator.generateWorkflowV3({
            // The workflow triggers on a push to the branch Flui cut, so the
            // commit that adds it is the commit that starts the build.
            branchName: head,
            githubOwner: request.owner,
            repoName: request.repo,
            appSlug: entry.result.app.slug,
            fluiAppId: entry.result.app.id,
            fluiWebhookUrl: `${baseUrl}/api/v1/webhooks/github-actions`,
            backendPollingOnly,
            subPath: entry.result.buildPaths.subPath,
            dockerfilePath: entry.result.buildPaths.dockerfile,
            buildContext: entry.result.buildPaths.context,
            buildArgs: entry.result.manifest.build?.args,
            workflowFileName: entry.workflowFileName,
          }),
        },
      );
    }
    return files;
  }

  private async markAppliedUnits(
    ctx: {
      userId: string;
      request: RepoApplyRequest;
      repoFullName: string;
      head: string;
    },
    prepared: PreparedEntry[],
    commit: { sha: string },
    webhookToken: string,
  ): Promise<AppliedUnitDto[]> {
    const applied: AppliedUnitDto[] = [];
    for (const entry of prepared) {
      const common = {
        unitId: entry.unit.unitId,
        name: entry.result.app.name,
        applicationId: entry.result.app.id,
        slug: entry.result.app.slug,
        manifestPath: manifestPathFor(entry.unit.unitId),
        workflowPath: `.github/workflows/${entry.workflowFileName}`,
        // Read off the row that was just prepared, where
        // `materializeDeclaredSecrets` has already turned every `secret: true`
        // the render declared without a value into a pending key. Names only.
        pendingInputs: (entry.result.app.env ?? [])
          .filter((variable) => variable.pending)
          .map((variable) => variable.name),
      };
      try {
        const marked = await this.applicationWorkflow.markAwaitingExternalBuild(
          entry.result.app.id,
          ctx.userId,
          {
            app: entry.result.app,
            owner: ctx.request.owner,
            repo: ctx.request.repo,
            branch: ctx.head,
            workflowFileName: entry.workflowFileName,
            commitSha: commit.sha,
            workflowUrl: `https://github.com/${ctx.repoFullName}/blob/${ctx.head}/.github/workflows/${entry.workflowFileName}`,
            webhookToken,
            subPath: entry.result.buildPaths.subPath,
            dockerfilePath: entry.result.buildPaths.dockerfile,
            isFluiManaged: true,
            buildStarted: true,
            // N units, one request: the four-second wait this lookup needs is
            // affordable once and not N times. The build watcher resolves the
            // run on its next tick.
            resolveRun: false,
          },
        );
        await this.clearStrandedMark(entry);
        applied.push({
          ...common,
          status: 'AWAITING_BUILD',
          armed: true,
          workflowRunUrl: marked.runId
            ? `https://github.com/${ctx.repoFullName}/actions/runs/${marked.runId}`
            : undefined,
        });
      } catch (error) {
        applied.push(
          await this.recoverUnarmedUnit(entry, ctx.head, error, common),
        );
      }
    }
    return applied;
  }

  /**
   * Arming is not one write. The status and the webhook token are stored first, the build
   * record after — so a throw can leave the row already armed and perfectly able to deploy.
   * Reporting the throw as `PENDING / armed: false / answers 401` was then false in the
   * other direction, and it also marked a healthy row for a reuse the filters would never
   * grant. What the database holds decides, not which call threw.
   */
  private async recoverUnarmedUnit(
    entry: PreparedEntry,
    head: string,
    error: unknown,
    common: Pick<
      AppliedUnitDto,
      | 'unitId'
      | 'name'
      | 'applicationId'
      | 'slug'
      | 'manifestPath'
      | 'workflowPath'
      | 'pendingInputs'
    >,
  ): Promise<AppliedUnitDto> {
    const reason = messageOf(error);
    const settled = await this.armedState(entry.result.app.id);
    this.logger.error(
      `${entry.result.app.slug} (${entry.result.app.id}) was committed on ${head} but arming threw: ${reason}. ` +
        (settled.armed
          ? 'The row is armed even so; its build will report back and deploy.'
          : 'Its build is running and its webhook will be answered with a 401.'),
    );
    if (settled.armed) {
      return {
        ...common,
        status: settled.status,
        armed: true,
        reason: `Armed, though finishing it threw: ${reason}. Its build reports back normally.`,
      };
    }
    // Marked for the next apply the same way a rollback marks: this row is
    // real, it owns whatever services it attached, and nothing here deletes
    // it. Best effort — the thing that failed to arm it is often the same
    // thing that will fail to mark it.
    const markedForReuse = await this.markStranded(
      entry,
      head,
      `not armed after the commit: ${reason}`,
    );
    return {
      ...common,
      status: settled.status,
      armed: false,
      markedForReuse,
      reason:
        `Committed, and its build is running, but Flui could not finish arming it: ${reason}. ` +
        'Until it is armed its build reports back to a webhook that answers 401, so it will not deploy on its own. ' +
        (markedForReuse
          ? 'It is marked, so the next apply of this repository reuses it instead of creating a second one beside it.'
          : 'Flui could NOT mark it for reuse, so the next apply will create a new one: remove this by hand first.'),
    };
  }

  /**
   * What an apply is allowed to do about the applications it already created
   * when it fails before the commit: name them, and mark them so the next
   * apply reuses them. Not delete them.
   *
   * Deleting would be the tidy answer and it is the wrong one. Preparing an
   * application runs `reconcileAttachedServices`, so unit 2 of 5 may already
   * own a Postgres with rows in it. In this house a service is removed through
   * the removal preview, which offers a snapshot of what it is about to take
   * away — never as the silent cleanup of somebody else's failure. So the
   * rollback stops at the branch (an empty ref, nothing of the author's) and
   * the error carries the rest: id, slug, branch, and the services that now
   * exist, in a form a person can act on.
   *
   * The cost of that choice, stated plainly: an apply that fails halfway
   * leaves rows behind. The mark is what keeps them from multiplying — the
   * next apply of the same repository adopts them instead of creating a second
   * set beside them — and a person who wants them gone deletes them from Flui,
   * where the preview will show them their database first.
   */
  private async strandedFailure(
    error: unknown,
    ctx: {
      prepared: PreparedEntry[];
      head: string;
      branchDeleted: boolean;
      repoFullName: string;
      clusterId: string;
    },
  ): Promise<Error> {
    const cause = messageOf(error);
    let allMarked = true;
    for (const entry of ctx.prepared) {
      const marked = await this.markStranded(
        entry,
        ctx.head,
        `the apply failed before it committed: ${cause}`,
      );
      allMarked = allMarked && marked;
    }

    const listed = ctx.prepared.map((entry) => {
      const services =
        entry.result.attachedServices.length > 0
          ? `services already installed for it: ${entry.result.attachedServices.join(', ')}`
          : 'no attached services';
      return (
        `  • ${entry.result.app.name} (slug \`${entry.result.app.slug}\`, id ${entry.result.app.id}, ` +
        `unit \`${entry.unit.unitId}\`) — ${services}`
      );
    });

    const reuse = allMarked
      ? 'They are marked, so the next apply of this repository reuses them instead of creating a second set beside them.'
      : 'Flui could NOT mark them for reuse, so the next apply will not recognise them and will create new ones: remove these by hand first.';

    const message =
      `Applying ${ctx.repoFullName} failed after ${ctx.prepared.length} application(s) had already been created. ` +
      (ctx.branchDeleted
        ? `The branch ${ctx.head} was deleted and nothing was committed, but `
        : `Nothing was committed, but the branch ${ctx.head} could NOT be deleted and still exists — delete it, or the next apply from this commit is refused as one already in flight; and `) +
      `these rows exist on cluster ${ctx.clusterId} ` +
      'and Flui does not delete an application on its own — one of them may already own a database:\n' +
      `${listed.join('\n')}\n` +
      `${reuse} To remove one instead, delete it from Flui: the removal preview will show what it would take with it and offer a snapshot.\n` +
      `The failure itself: ${cause}`;

    // The original status, not one of our own: the caller is entitled to know
    // whether this was their request or our machinery, and inventing a code
    // here would be a second false statement on top of a failure.
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    return new HttpException(
      {
        statusCode: status,
        error: 'ApplyLeftApplicationsBehind',
        message,
        branch: ctx.head,
        branchDeleted: ctx.branchDeleted,
        committed: false,
        markedForReuse: allMarked,
        strandedApplications: ctx.prepared.map((entry) => ({
          applicationId: entry.result.app.id,
          name: entry.result.app.name,
          slug: entry.result.app.slug,
          unitId: entry.unit.unitId,
          branch: ctx.head,
          attachedServices: entry.result.attachedServices,
        })),
      },
      status,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  /**
   * Records on the application itself that an apply left it behind, and why.
   *
   * Best effort on purpose: this runs on a failure path, and the failure is
   * often the very thing that would make this write fail too. The caller is
   * told whether it worked, because "the next apply will reuse them" is only
   * true if it did.
   */
  private async markStranded(
    entry: PreparedEntry,
    branch: string,
    reason: string,
  ): Promise<boolean> {
    const mark: StrandedApplyMark = {
      at: new Date().toISOString(),
      branch,
      unitId: entry.unit.unitId,
      reason,
      services: entry.result.attachedServices,
    };
    try {
      await this.applicationsRepository.update(entry.result.app.id, {
        metadata: {
          ...entry.result.app.metadata,
          [STRANDED_APPLY_KEY]: JSON.stringify(mark),
        },
      });
      return true;
    } catch (error) {
      this.logger.error(
        `Could not mark ${entry.result.app.slug} (${entry.result.app.id}) as left behind: ` +
          `${messageOf(error)}. The next apply will not recognise it.`,
      );
      return false;
    }
  }

  /** An application that finished the round it was left out of is no longer stranded. */
  private async clearStrandedMark(entry: PreparedEntry): Promise<void> {
    const metadata = entry.result.app.metadata;
    if (!metadata?.[STRANDED_APPLY_KEY]) return;
    const { [STRANDED_APPLY_KEY]: _dropped, ...rest } = metadata;
    try {
      await this.applicationsRepository.update(entry.result.app.id, {
        metadata: rest,
      });
    } catch (error) {
      this.logger.warn(
        `Could not clear the stranded mark on ${entry.result.app.slug}: ${messageOf(error)}`,
      );
    }
  }

  /**
   * The applications an earlier apply of this repository left behind, by
   * manifest name.
   *
   * The three conditions are what makes reuse safe rather than a hijack: still
   * `PENDING` (never deployed), no `webhookToken` (never armed, so nothing is
   * reporting into it), and carrying the mark this service writes (so an
   * application in the middle of a concurrent apply, which has neither, is
   * never taken).
   *
   * Reading it is a courtesy, not a precondition: if the query fails the apply
   * goes on and creates new applications, which is what it did before this
   * existed. It says so rather than pretending it looked.
   */
  /**
   * The row a unit left behind when its own preparation threw.
   *
   * `prepareApplicationFromYaml` writes the Application before it provisions the services, so the
   * throw that matters most — a block that never reaches RUNNING — happens with a row already in
   * the database and, often, a database already running for it. Read it back by the only identity
   * that can name it: this cluster, this repository, the branch this apply cut, and the unit's own
   * name. Best-effort by design: failing to find it must not replace the original failure, which
   * is the one the caller needs.
   */
  private async applicationLeftBy(
    request: RepoApplyRequest,
    head: string,
    unitName: string,
  ): Promise<PreparedApplicationFromYaml | null> {
    try {
      const candidates = await this.applicationsRepository.findByClusterId(
        request.clusterId,
      );
      const found = candidates.find((app) => {
        const cfg = app.sourceConfig as {
          repositoryId?: string;
          branch?: string;
        } | null;
        return (
          cfg?.repositoryId === request.repositoryId &&
          cfg?.branch === head &&
          app.name === unitName
        );
      });
      if (!found) return null;
      let attached: string[] = [];
      try {
        const rows =
          (await this.attachedServices?.attachmentsOf(found.id)) ?? [];
        attached = rows.map((row) => `${row.name}=${row.block}`);
      } catch (error) {
        this.logger.warn(
          `Could not list the services of ${found.slug}, which an apply of ${request.owner}/${request.repo} left behind: ${messageOf(error)}`,
        );
      }
      return {
        app: found,
        attachedServices: attached,
      } as PreparedApplicationFromYaml;
    } catch (error) {
      this.logger.warn(
        `Could not look for the application unit \`${unitName}\` left behind on ${head}: ${messageOf(error)}`,
      );
      return null;
    }
  }

  /** What the database actually holds for a row whose arming threw. An application is armed when
   * it is waiting for its build AND holds the token its webhook is checked against; either alone
   * is not enough, and the call that threw says nothing about which of the two landed. */
  private async armedState(
    applicationId: string,
  ): Promise<{ armed: boolean; status: string }> {
    try {
      const row = await this.applicationsRepository.findById(applicationId);
      if (!row) return { armed: false, status: 'PENDING' };
      const armed =
        row.status === ApplicationStatus.AWAITING_BUILD &&
        Boolean(row.webhookToken);
      // The two words this DTO uses, not the enum's own spelling: `status` here is the applied
      // unit's armed-or-not, and the rest of this response says it in upper case.
      return { armed, status: armed ? 'AWAITING_BUILD' : 'PENDING' };
    } catch {
      // Unknowable is not armed: claiming otherwise would send someone away from a row that never
      // deploys.
      return { armed: false, status: 'PENDING' };
    }
  }

  private async strandedApplications(
    request: RepoApplyRequest,
  ): Promise<Map<string, { id: string; slug: string }>> {
    const found = new Map<string, { id: string; slug: string }>();
    try {
      const candidates = await this.applicationsRepository.findByClusterId(
        request.clusterId,
        { status: ApplicationStatus.PENDING },
      );
      for (const app of candidates) {
        const cfg = app.sourceConfig as { repositoryId?: string } | null;
        if (cfg?.repositoryId !== request.repositoryId) continue;
        if (app.webhookToken) continue;
        if (!app.metadata?.[STRANDED_APPLY_KEY]) continue;
        // `findByClusterId` orders newest first, so the first match for a name
        // is the most recent attempt — the one whose services are current.
        if (!found.has(app.name)) found.set(app.name, app);
      }
      if (found.size > 0) {
        this.logger.log(
          `Reusing ${found.size} application(s) an earlier apply of ${request.owner}/${request.repo} left behind: ` +
            quoteAll([...found.values()].map((a) => a.slug)),
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not look for applications left behind by an earlier apply of ${request.owner}/${request.repo}: ` +
          `${messageOf(error)}. This apply will create new ones.`,
      );
    }
    return found;
  }

  /**
   * The refusals that must happen before anything is written, in the order a
   * reader would ask them: could the repository be read, does the verdict allow
   * a deploy, is there anything to deploy, and — when the caller narrowed the
   * set — does every unit they named actually have a manifest.
   */
  private selectUnits(
    map: RepositoryMapResponseDto,
    request: RepoApplyRequest,
    repoFullName: string,
  ): RenderedUnitRef[] {
    if (!map.read.ok || !map.render) {
      throw new UnprocessableEntityException(
        `${repoFullName}@${request.branch} could not be read (${map.read.reason}), so there is nothing to apply. ` +
          (map.verdict.remedy ?? ''),
      );
    }

    if (REFUSED_VERDICTS.has(map.verdict.outcome)) {
      throw new UnprocessableEntityException(
        `Flui will not apply a map whose verdict is \`${map.verdict.outcome}\`. ${map.verdict.reason} ` +
          (map.verdict.remedy ? `${map.verdict.remedy} ` : '') +
          'Nothing was written to the repository.',
      );
    }

    // `partial` is not in REFUSED_VERDICTS on purpose — some units are fine and deserve to go —
    // but it is exactly the verdict where a blocked unit sits next to a ready one, so the
    // per-unit readiness is what decides, not the render.
    const readiness = new Map(
      map.verdict.units.map((u) => [u.id, u.readiness as string]),
    );
    const blockedIds = new Set(
      map.render.units
        .map((u) => u.unitId)
        .filter((id) => !APPLIABLE_READINESS.has(readiness.get(id) ?? '')),
    );

    const rendered: RenderedUnitRef[] = map.render.units
      .filter((unit) => !blockedIds.has(unit.unitId))
      .map((unit) => ({
        unitId: unit.unitId,
        name: unit.name,
        yaml: unit.yaml,
      }));

    if (rendered.length === 0) {
      const why = map.render.skipped
        .map((s) => `\`${s.unitId}\`: ${s.reason}`)
        .join('; ');
      const held =
        blockedIds.size > 0
          ? ` Units the map will not deploy — ${quoteAll([...blockedIds])}.`
          : '';
      throw new UnprocessableEntityException(
        `The map of ${repoFullName}@${request.branch} produced no deployable manifest, so there is nothing to commit.` +
          (why ? ` Units skipped — ${why}` : '') +
          held,
      );
    }

    if (!request.unitIds || request.unitIds.length === 0) return rendered;

    const byId = new Map(rendered.map((u) => [u.unitId, u]));
    // Asking for a unit the map refuses is a different mistake from asking for one that does not
    // exist, and it deserves its own sentence: the first is answerable, the second is a typo.
    const asked = [...new Set(request.unitIds)];
    const refused = asked.filter((id) => blockedIds.has(id));
    if (refused.length > 0) {
      throw new UnprocessableEntityException(
        `The map will not deploy ${quoteAll(refused)} — ${quoteAll(refused)} ` +
          `${refused.length === 1 ? 'is' : 'are'} not in a state this can act on. Nothing was written to the repository.`,
      );
    }
    const missing = asked.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const named = quoteAll(missing);
      const available = quoteAll(rendered.map((u) => u.unitId));
      throw new BadRequestException(
        `No manifest was rendered for ${named}. Applicable units are ${available}.`,
      );
    }
    return asked.map((id) => byId.get(id) as RenderedUnitRef);
  }
}

interface RenderedUnitRef {
  unitId: string;
  name: string;
  yaml: string;
}

/**
 * Where a unit's manifest goes: `flui.yaml` in the unit's own directory, which
 * for the repository root (`unitId === '.'`) is the repository root. Not a
 * `.flui/` directory of our own — this is the file the author promotes onto
 * their branch afterwards, so it has to land where they would have written it,
 * and where `getFluiManifests` already looks for it.
 */
export function manifestPathFor(unitId: string): string {
  const dir = unitId
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  return dir === '' ? 'flui.yaml' : `${dir}/flui.yaml`;
}

/** What an unknown thrown thing says, without `[object Object]`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function quoteAll(values: string[]): string {
  return values.map((v) => `\`${v}\``).join(', ');
}
