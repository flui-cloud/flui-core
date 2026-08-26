import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserEntity } from '../../auth/entities/user.entity';
import { EntryHands } from './entry-hands';

/**
 * The names, read from the identity directory.
 *
 * The `select` is the enforcement and not an optimisation: `email` is never
 * loaded, so no later edit of this file can deliver an address by accident, and
 * a review of what leaves this module only has to read one line. An account
 * with no name recorded produces no entry — the note then reads as unsigned,
 * which is true. Falling back to the address would be the exact substitution
 * this port exists to prevent, and the way to fix an unsigned note is to give
 * the person a name, not to publish their inbox.
 */
@Injectable()
export class UserEntryHands implements EntryHands {
  private readonly logger = new Logger(UserEntryHands.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  async namesOf(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id) => !!id))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    let rows: UserEntity[] = [];
    try {
      rows = await this.users.find({
        where: { id: In(ids) },
        select: ['id', 'displayName', 'name', 'firstName', 'lastName'],
      });
    } catch (e) {
      // An unsigned note is a smaller failure than a note that will not load.
      this.logger.warn(`could not resolve who wrote a note: ${e}`);
      return out;
    }
    for (const u of rows) {
      const name = nameOf(u);
      if (name) out.set(u.id, name);
    }
    return out;
  }
}

function nameOf(u: UserEntity): string | null {
  const full = [u.firstName, u.lastName].filter((p) => !!p).join(' ');
  return u.displayName || u.name || full || null;
}
