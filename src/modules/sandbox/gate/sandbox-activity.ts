import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';

export const SANDBOX_ACTIVITY = 'SANDBOX_ACTIVITY';

export interface SandboxActivity {
  touch(userId: string, now?: Date): Promise<void>;
}

const WRITE_EVERY_MS = 60_000;

/**
 * Remembers when a guest last did something in their area: what keeps their
 * applications alive. Written at most once a minute per person, and a fresh
 * action clears the warning already sent, so the next one can go out.
 */
@Injectable()
export class SandboxActivityService implements SandboxActivity {
  private readonly lastWrite = new Map<string, number>();

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
  ) {}

  async touch(userId: string, now = new Date()): Promise<void> {
    const last = this.lastWrite.get(userId);
    if (last !== undefined && now.getTime() - last < WRITE_EVERY_MS) return;
    this.lastWrite.set(userId, now.getTime());
    await this.tenants.update(
      { userId, state: SandboxTenantState.CLAIMED },
      { lastActiveAt: now, expiryWarnedAt: null },
    );
  }
}
