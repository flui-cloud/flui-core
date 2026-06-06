import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../entities/user.entity';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';

const SYNC_TTL_SECONDS = 300;
// Don't retry a failing provider on every request — back off per sub.
const FAILURE_BACKOFF_SECONDS = 60;
const FALLBACK_EMAIL_RE = /^oidc-.*@flui\.invalid$/;

@Injectable()
export class OidcProfileSyncService {
  private readonly logger = new Logger(OidcProfileSyncService.name);
  private patWarningEmitted = false;
  private readonly recentFailures = new Map<string, number>();

  constructor(
    private readonly oidcAdmin: OidcProviderAdminClient,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async syncFromProvider(
    user: UserEntity,
    opts: { force?: boolean } = {},
  ): Promise<UserEntity> {
    if (!user.oidcSub) return user;
    if ((process.env.AUTH_MODE ?? '').toLowerCase() === 'local') return user;

    if (!opts.force && this.isFresh(user.profileSyncedAt)) return user;
    if (!opts.force && this.inFailureBackoff(user.oidcSub)) return user;

    const pat = (process.env.ZITADEL_SERVICE_ACCOUNT_PAT ?? '').trim();
    if (!pat) {
      if (!this.patWarningEmitted) {
        this.logger.warn(
          'ZITADEL_SERVICE_ACCOUNT_PAT not set — profile sync skipped',
        );
        this.patWarningEmitted = true;
      }
      user.profileSyncedAt = new Date();
      return this.userRepo.save(user);
    }

    const issuer = (
      process.env.OIDC_ISSUER ??
      process.env.ZITADEL_ISSUER ??
      ''
    ).trim();
    if (!issuer) return user;
    const hostHeader = issuer.replace(/^https?:\/\//, '');

    try {
      const profile = await this.oidcAdmin.getUser(
        pat,
        hostHeader,
        user.oidcSub,
      );
      if (!profile) {
        this.logger.warn(`Profile not found for sub ${user.oidcSub}`);
        user.profileSyncedAt = new Date();
        return this.userRepo.save(user);
      }

      this.applyProfileToUser(user, profile);
      user.profileSyncedAt = new Date();
      this.recentFailures.delete(user.oidcSub);

      const saved = await this.userRepo.save(user);
      this.logger.log(
        `Synced profile for sub ${user.oidcSub} (${saved.email})`,
      );
      return saved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(user.oidcSub, msg);
      return user;
    }
  }

  private recordFailure(sub: string, msg: string): void {
    const firstFailure = !this.recentFailures.has(sub);
    this.recentFailures.set(sub, Date.now());
    if (firstFailure) {
      this.logger.warn(
        `Profile sync failed for sub ${sub}: ${msg} — falling back to cached row (backing off ${FAILURE_BACKOFF_SECONDS}s)`,
      );
    }
  }

  private isFresh(syncedAt: Date | null): boolean {
    if (!syncedAt) return false;
    const ageSec = (Date.now() - new Date(syncedAt).getTime()) / 1000;
    return ageSec >= 0 && ageSec < SYNC_TTL_SECONDS;
  }

  private inFailureBackoff(sub: string): boolean {
    const last = this.recentFailures.get(sub);
    if (last === undefined) return false;
    const ageSec = (Date.now() - last) / 1000;
    if (ageSec >= FAILURE_BACKOFF_SECONDS) {
      this.recentFailures.delete(sub);
      return false;
    }
    return true;
  }

  private applyProfileToUser(
    user: UserEntity,
    profile: {
      email?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      userName?: string | null;
    },
  ): void {
    const incomingEmail = profile.email?.trim() || null;
    const placeholder = FALLBACK_EMAIL_RE.test(user.email);
    if (incomingEmail && (placeholder || incomingEmail !== user.email)) {
      user.email = incomingEmail;
    }
    user.firstName = profile.firstName ?? null;
    user.lastName = profile.lastName ?? null;
    const fullName = [profile.firstName, profile.lastName]
      .filter((p): p is string => !!p && p.length > 0)
      .join(' ');
    user.displayName = fullName || profile.userName || null;
    user.name = user.displayName ?? user.name;
  }
}
