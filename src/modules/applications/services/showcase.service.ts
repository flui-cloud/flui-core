import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationStatus } from '../enums/application-status.enum';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { SHOWCASE_TAG, isShowcase } from '../../iam/constants/iam-showcase';

export interface ShowcaseItem {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  note: string | null;
  runningSince: Date;
  url: string | null;
}

/**
 * The shared, read-only corner of a demo instance.
 *
 * The mark was already here and is not repeated: an application is in the
 * showcase when it carries the `showcase` tag, which is also what
 * `SHOWCASE_GRANT` selects on, so joining or leaving the showcase never
 * rewrites a grant. A second column saying the same thing would be a second
 * answer to "is this in the showcase", free to disagree with the one the
 * authorization layer reads.
 *
 * What was missing is this: the read. It is a deliberately narrow shape rather
 * than the application record with a filter over it — the showcase is the one
 * read that crosses from the operator's things to somebody else's screen, so
 * what it shows has to be a decision, not the residue of a query somebody might
 * widen later.
 */
@Injectable()
export class ShowcaseService {
  private readonly logger = new Logger(ShowcaseService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly endpoints: AppEndpointService,
  ) {}

  /** Everything in the showcase, oldest first: the point is how long it has run. */
  async list(): Promise<ShowcaseItem[]> {
    const rows = await this.applications
      .createQueryBuilder('app')
      // The parameter has to reach Postgres as JSON, not as a JS array: bound
      // as an array it arrives as an array literal and `@>` on a jsonb column
      // rejects it outright ("invalid input syntax for type json"). Same shape
      // as the two other containment queries in this codebase.
      .where('app.tags @> :tag::jsonb', {
        tag: JSON.stringify([SHOWCASE_TAG]),
      })
      .orderBy('app.createdAt', 'ASC')
      .getMany();
    if (rows.length === 0) return [];

    const urls = await this.endpoints.mapPrimaryEndpoints(
      rows.map((r) => r.id),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: String(row.kind),
      status: String(row.status),
      // The line next to it is the application's own description: the showcase
      // does not get a second place to say what something is.
      note: row.description ?? null,
      runningSince: row.createdAt,
      url: urls.get(row.id)?.fqdn ? `https://${urls.get(row.id)!.fqdn}` : null,
    }));
  }

  /**
   * Adds the tag, and nothing else unless a line is given. Tagging is what puts
   * an application in the showcase everywhere — here, in the grant selector and
   * on the application's own screen.
   *
   * Entering the showcase is gated on the application actually running, which
   * is the one rule that keeps the whole thing honest: the showcase claims that
   * what is in it is real and has been up for a while, and the only defence
   * against that becoming a slogan is refusing to admit something that is not
   * running when it is admitted. Nothing here manufactures the claim — the
   * status and the date are both read off the row.
   *
   * The gate is on the way in only. An application that fails *after* it was
   * published stays, showing the status it really has: a real failure on a real
   * instance is the truth, and hiding it would be the dishonest half.
   */
  async publish(applicationId: string, note?: string): Promise<ShowcaseItem> {
    const application = await this.byId(applicationId);

    if (!isShowcase(application.tags)) {
      this.assertRunning(application);
      await this.assertItsClusterIsStillThere(application);
      application.tags = [...(application.tags ?? []), SHOWCASE_TAG];
    }
    if (note?.trim()) {
      application.description = note.trim();
    }
    await this.applications.save(application);
    this.logger.log(`${application.slug} is in the showcase`);

    const published = (await this.list()).find((i) => i.id === applicationId);
    if (!published) {
      throw new NotFoundException(
        `Application ${applicationId} is tagged but not listable`,
      );
    }
    return published;
  }

  /** Takes the tag off. The application keeps running, and keeps its owner. */
  async withdraw(applicationId: string): Promise<void> {
    const application = await this.byId(applicationId);
    application.tags = (application.tags ?? []).filter(
      (tag) => tag !== SHOWCASE_TAG,
    );
    await this.applications.save(application);
    this.logger.log(`${application.slug} left the showcase`);
  }

  /**
   * Resolves what a person types — a slug, a name or an id — to one
   * application, and refuses rather than guessing when it names several.
   */
  async resolve(ref: string): Promise<ApplicationEntity> {
    const bySlug = await this.applications.findOne({ where: { slug: ref } });
    if (bySlug) return bySlug;

    if (/^[0-9a-f-]{36}$/i.test(ref)) {
      const byId = await this.applications.findOne({ where: { id: ref } });
      if (byId) return byId;
    }

    const byName = await this.applications.find({ where: { name: ref } });
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new NotFoundException(
        `"${ref}" names ${byName.length} applications; use a slug or an id`,
      );
    }
    throw new NotFoundException(`No application "${ref}"`);
  }

  /**
   * An application whose cluster has been deleted still says `running` and
   * still carries an endpoint marked `IN_SYNC`, so the showcase can publish an
   * address that refuses the connection.
   *
   * `status` is the last thing a reconciler wrote before the cluster went away,
   * and nothing rewrites it afterwards: there is no cluster left to ask. So the
   * running check cannot catch this on its own, and asking whether the machine
   * is still there is the only honest question. The showcase is the one read
   * that crosses from the operator's things to a stranger's screen, which is
   * why it is asked here rather than left to whoever looks at the row next.
   */
  private async assertItsClusterIsStillThere(
    application: ApplicationEntity,
  ): Promise<void> {
    const cluster = await this.clusters.findOne({
      where: { id: application.clusterId },
      select: { id: true, name: true, status: true },
    });
    const gone =
      !cluster ||
      cluster.status === ClusterStatus.DELETED ||
      cluster.status === ClusterStatus.DELETING;
    if (!gone) return;
    throw new BadRequestException(
      `${application.slug} belongs to a cluster that is ${cluster ? cluster.status : 'no longer registered'}, so whatever its record says, it is not running anywhere. The showcase only takes applications that are really up.`,
    );
  }

  /**
   * `running`, and no near-miss admitted. `provisioning`, `updating` and
   * `degraded` are all states an application passes through on its way to
   * working or on its way out of it, and a showcase that accepts them is one
   * that can be filled with things that never came up. The wait is seconds and
   * publishing is a one-off act, so the strict reading costs a retry and buys
   * the claim.
   */
  private assertRunning(application: ApplicationEntity): void {
    if (application.status === ApplicationStatus.RUNNING) return;
    throw new BadRequestException(
      `${application.slug} is ${application.status}, not running. The showcase says that what is in it is really running here, so it only takes applications that are — publish it once it is up.`,
    );
  }

  private async byId(id: string): Promise<ApplicationEntity> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return application;
  }
}
