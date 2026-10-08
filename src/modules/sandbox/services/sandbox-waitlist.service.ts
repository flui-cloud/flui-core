import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { SandboxWaitlistEntity } from '../entities/sandbox-waitlist.entity';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { SandboxNoticeMailService } from './sandbox-notice-mail.service';
import { SandboxEntryService } from './sandbox-entry.service';
import { isPlaceholderEmail } from '../../auth/utils/placeholder-email.util';

/**
 * Hands freed spaces to the people waiting, in order of arrival. An offer
 * holds the space for `waitlistOfferMs`; one left unused goes back, and the
 * person who let it lapse leaves the list (they can join again by deploying).
 */
@Injectable()
export class SandboxWaitlistService {
  private readonly logger = new Logger(SandboxWaitlistService.name);

  constructor(
    @InjectRepository(SandboxWaitlistEntity)
    private readonly waitlist: Repository<SandboxWaitlistEntity>,
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
    private readonly notices: SandboxNoticeMailService,
    private readonly entry: SandboxEntryService,
  ) {}

  /** Returns how many offers went out. */
  async offerFreedSlots(now = new Date()): Promise<number> {
    await this.waitlist.delete({ offerExpiresAt: LessThanOrEqual(now) });

    const inUse = await this.tenants.count({
      where: { state: SandboxTenantState.CLAIMED },
    });
    const held = await this.waitlist.count({
      where: { offerExpiresAt: MoreThan(now) },
    });
    const free = this.config.maxSlots - inUse - held;
    if (free <= 0) return 0;

    const next = await this.waitlist.find({
      where: { offeredAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: free,
    });
    const expires = new Date(now.getTime() + this.config.waitlistOfferMs);
    for (const person of next) {
      await this.waitlist.update(person.id, {
        offeredAt: now,
        offerExpiresAt: expires,
      });
      if (person.email && !isPlaceholderEmail(person.email)) {
        await this.notices.waitlistOffer({
          to: person.email,
          hours: Math.round(this.config.waitlistOfferMs / 3_600_000),
          dashboardUrl: this.entry.origin,
        });
      }
    }
    if (next.length > 0) {
      this.logger.log(`Offered ${next.length} demo space(s) to people waiting`);
    }
    return next.length;
  }
}
