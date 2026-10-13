import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  OidcVisitorLoginClient,
  VisitorSession,
} from '../../oidc/services/oidc-visitor-login.client';
import {
  IDENTITY_DIRECTORY,
  IIdentityDirectory,
} from '../../auth/interfaces/identity-directory.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { describeError } from '../../shared/utils/error.util';
import { SandboxVisitorPoolEntity } from '../entities/sandbox-visitor-pool.entity';
import { serviceConnection } from './provider-connection';
import { VisitorLoginClientService } from './visitor-login-client.service';
import {
  throwawayPassword,
  visitorIdentity,
  writeVisitorRows,
} from './visitor-rows';
import { VISITOR_CONFIG, VisitorConfig } from './visitor.config';

/** A ready visitor that has not been taken is remade after this, so no session sits around for long. */
export const POOL_ENTRY_TTL_MS = 24 * 3_600_000;

export interface MadeVisitor {
  idpUserId: string;
  email: string;
  session: VisitorSession;
}

export interface EnteredVisitor {
  userId: string;
  session: VisitorSession;
  fromPool: boolean;
}

interface TakenRow {
  id: string;
  idpUserId: string;
  sessionId: string;
  token: string;
}

/**
 * Visitors made ahead of time. Making one costs the identity provider two
 * password hashes, about five seconds; taking one from here costs a row.
 */
@Injectable()
export class VisitorPoolService {
  private readonly logger = new Logger(VisitorPoolService.name);

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    @InjectRepository(SandboxVisitorPoolEntity)
    private readonly pool: Repository<SandboxVisitorPoolEntity>,
    private readonly dataSource: DataSource,
    private readonly login: OidcVisitorLoginClient,
    private readonly loginClient: VisitorLoginClientService,
    private readonly encryption: EncryptionService,
    @Inject(IDENTITY_DIRECTORY) private readonly directory: IIdentityDirectory,
  ) {}

  /** An identity-provider visitor with an open session; nothing local yet. */
  async make(seed: string = randomUUID()): Promise<MadeVisitor> {
    const conn = serviceConnection();
    const loginPat = await this.loginClient.token();
    if (!conn || !loginPat) {
      throw new Error('the identity provider is not prepared for visitors');
    }
    const { userName, email } = visitorIdentity(seed);
    const password = throwawayPassword();
    const idpUserId = await this.login.createHuman(conn.pat, conn.host, {
      userName,
      email,
      password,
    });
    try {
      const session = await this.login.createSession(
        loginPat,
        conn.host,
        idpUserId,
        password,
      );
      return { idpUserId, email, session };
    } catch (error) {
      await this.removeAtProvider(idpUserId);
      throw error;
    }
  }

  async ready(now = new Date()): Promise<number> {
    return this.pool.count({
      where: {
        takenAt: IsNull(),
        createdAt: MoreThan(new Date(now.getTime() - POOL_ENTRY_TTL_MS)),
      },
    });
  }

  /** Makes visitors until `poolMin` are ready; one at a time, at most `poolMin` per pass. */
  async refill(): Promise<number> {
    const missing = this.config.poolMin - (await this.ready());
    let made = 0;
    try {
      for (let i = 0; i < missing; i++) {
        const id = randomUUID();
        const visitor = await this.make(id);
        await this.pool.insert({
          id,
          idpUserId: visitor.idpUserId,
          sessionId: visitor.session.sessionId,
          sessionTokenEncrypted: this.encryption.encrypt(
            visitor.session.sessionToken,
          ),
        });
        made += 1;
      }
    } finally {
      // Said even when a later one fails: that failure is reported once
      // by the scheduler, and these would otherwise go unmentioned.
      if (made > 0) this.logger.log(`Made ${made} visitor(s) ahead of time`);
    }
    return made;
  }

  /** Untaken visitors past their day go at the identity provider; a taken row left by an older copy goes too. */
  async recycle(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - POOL_ENTRY_TTL_MS);
    const stale = await this.pool.find({
      where: { takenAt: IsNull(), createdAt: LessThan(before) },
      take: 50,
    });
    let removed = 0;
    for (const entry of stale) {
      try {
        await this.removeAtProvider(entry.idpUserId);
        await this.pool.delete({ id: entry.id, takenAt: IsNull() });
        removed += 1;
      } catch (error) {
        this.logger.warn(
          `Could not recycle visitor ${entry.idpUserId}: ${describeError(error)}`,
        );
      }
    }
    await this.pool.delete({ takenAt: Not(IsNull()) });
    return removed;
  }

  /**
   * A visitor for the person at the door, with its local rows: from the pool
   * when one is ready, made on the spot when none is.
   */
  async enter(ipHash: string | null): Promise<EnteredVisitor> {
    const taken = await this.dataSource.transaction(async (m) => {
      const row = await this.takeOne(m);
      if (!row) return null;
      const { email } = visitorIdentity(row.id);
      const userId = await writeVisitorRows(m, {
        idpUserId: row.idpUserId,
        email,
        ipHash,
      });
      return {
        userId,
        session: {
          sessionId: row.sessionId,
          sessionToken: this.encryption.decrypt(row.token),
        },
        fromPool: true,
      };
    });
    if (taken) return taken;

    this.logger.warn('No visitor was ready; making one on the spot');
    const made = await this.make();
    try {
      const userId = await this.dataSource.transaction((m) =>
        writeVisitorRows(m, {
          idpUserId: made.idpUserId,
          email: made.email,
          ipHash,
        }),
      );
      return { userId, session: made.session, fromPool: false };
    } catch (error) {
      await this.removeAtProvider(made.idpUserId);
      throw error;
    }
  }

  private async takeOne(m: EntityManager): Promise<TakenRow | null> {
    const fresh = new Date(Date.now() - POOL_ENTRY_TTL_MS);
    const result: unknown = await m.query(
      `WITH picked AS (
         SELECT "id", "sessionTokenEncrypted" FROM "sandbox_visitor_pool"
          WHERE "takenAt" IS NULL AND "createdAt" > $1
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM "sandbox_visitor_pool" p
        USING picked
        WHERE p."id" = picked."id"
       RETURNING p."id", p."idpUserId", p."sessionId", picked."sessionTokenEncrypted" AS "token"`,
      [fresh],
    );
    const rows = (
      Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result
    ) as TakenRow[];
    return rows?.[0] ?? null;
  }

  private async removeAtProvider(idpUserId: string): Promise<void> {
    await this.directory.deleteUser(idpUserId).catch((error: unknown) => {
      if (!(error instanceof NotFoundException)) throw error;
    });
  }
}
