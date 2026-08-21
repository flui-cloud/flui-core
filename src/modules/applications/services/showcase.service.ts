import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../entities/application.entity';
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
    private readonly endpoints: AppEndpointService,
  ) {}

  /** Everything in the showcase, oldest first: the point is how long it has run. */
  async list(): Promise<ShowcaseItem[]> {
    const rows = await this.applications
      .createQueryBuilder('app')
      .where('app.tags @> :tag', { tag: [SHOWCASE_TAG] })
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
   */
  async publish(applicationId: string, note?: string): Promise<ShowcaseItem> {
    const application = await this.byId(applicationId);

    if (!isShowcase(application.tags)) {
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

  private async byId(id: string): Promise<ApplicationEntity> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return application;
  }
}
