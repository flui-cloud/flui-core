import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { ObjectStoreShareEntity } from '../entities/object-store-share.entity';
import { ShareClaims } from './object-store-share.service';

export interface ShareRecord {
  id: string;
  bucket: string;
  key: string;
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  status: 'active' | 'expired' | 'revoked';
}

/**
 * The revocation + visibility layer over the stateless HMAC share links. A row
 * is written when a link is minted (keyed by sha256 of the token — the raw token
 * is never stored) and read on the public access path to enforce revocation and
 * stamp last-accessed. Crypto + expiry stay the job of {@link ObjectStoreShareService};
 * this only adds what a presigned URL can't: kill-switch + usage visibility.
 */
@Injectable()
export class ObjectStoreShareRegistryService {
  private readonly logger = new Logger(ObjectStoreShareRegistryService.name);

  constructor(
    @InjectRepository(ObjectStoreShareEntity)
    private readonly repo: Repository<ObjectStoreShareEntity>,
  ) {}

  private tokenId(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Persist a link at mint time. Idempotent on tokenId (same link → same row). */
  async record(
    token: string,
    claims: ShareClaims,
    ownerUserId?: string,
  ): Promise<void> {
    const tokenId = this.tokenId(token);
    const existing = await this.repo.findOne({ where: { tokenId } });
    if (existing) return;
    await this.repo.save(
      this.repo.create({
        tokenId,
        appId: claims.appId,
        bucket: claims.bucket,
        objectKey: claims.key,
        ownerUserId: ownerUserId ?? null,
        expiresAt: new Date(claims.exp * 1000),
        revokedAt: null,
        lastAccessedAt: null,
      }),
    );
  }

  async list(appId: string, ownerUserId?: string): Promise<ShareRecord[]> {
    const rows = await this.repo.find({
      where: ownerUserId ? { appId, ownerUserId } : { appId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
    const now = Date.now();
    return rows.map((r) => this.toRecord(r, now));
  }

  async revoke(
    id: string,
    appId: string,
    ownerUserId?: string,
  ): Promise<ShareRecord> {
    const row = await this.repo.findOne({ where: { id, appId } });
    if (!row) throw new NotFoundException('Share link not found');
    if (ownerUserId && row.ownerUserId && row.ownerUserId !== ownerUserId) {
      throw new ForbiddenException('Not your share link');
    }
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      await this.repo.save(row);
    }
    return this.toRecord(row, Date.now());
  }

  /**
   * On a public access: reject if the link is tracked AND revoked, else
   * best-effort stamp lastAccessedAt. DB errors fail OPEN (the link's crypto +
   * expiry already gate it; the registry is a soft kill-switch, not the auth) —
   * logged, never thrown, so a DB blip never breaks an otherwise-valid download.
   */
  async checkAndTouch(token: string): Promise<void> {
    const tokenId = this.tokenId(token);
    let row: ObjectStoreShareEntity | null;
    try {
      row = await this.repo.findOne({ where: { tokenId } });
    } catch (e) {
      this.logger.warn(`share registry lookup failed (allowing): ${String(e)}`);
      return;
    }
    if (!row) return; // untracked link (e.g. minted before this feature) — allowed if crypto-valid
    if (row.revokedAt) {
      throw new BadRequestException('Share link revoked');
    }
    void this.repo
      .update({ id: row.id }, { lastAccessedAt: new Date() })
      .catch((e: unknown) =>
        this.logger.debug(
          `lastAccessed update failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  private toRecord(r: ObjectStoreShareEntity, now: number): ShareRecord {
    let status: ShareRecord['status'] = 'active';
    if (r.revokedAt) status = 'revoked';
    else if (r.expiresAt.getTime() <= now) status = 'expired';
    return {
      id: r.id,
      bucket: r.bucket,
      key: r.objectKey,
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
      lastAccessedAt: r.lastAccessedAt ? r.lastAccessedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      status,
    };
  }
}
