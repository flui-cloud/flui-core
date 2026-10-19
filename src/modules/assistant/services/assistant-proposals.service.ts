import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheService } from '../../common/cache/cache.service';
import { PendingAction } from '../interfaces/agent';
import { ToolCall } from '../interfaces/chat-completion';
import { cacheKey, parseArgs } from './tool-call.util';

const TTL_SECONDS = 15 * 60;
const key = (userId: string, toolCallId: string) =>
  `assistant-proposal:${userId}:${toolCallId}`;
const fingerprint = (name: string, args: unknown) =>
  createHash('sha256').update(cacheKey(name, args)).digest('hex');

/**
 * The confirmations a turn handed out, so that a resume can only confirm what
 * the server itself proposed.
 *
 * The agent route is stateless: the history and the approved ids both come
 * back from the client, so without this an approval confirms whatever call the
 * client chose to write, with whatever arguments. A proposal is bound to the
 * person it was shown to, the call id, the tool and its arguments; it lives in
 * the shared cache because the resume may reach another copy of the API, it
 * expires after fifteen minutes and it is spent on first use.
 */
@Injectable()
export class AssistantProposalsService {
  constructor(private readonly cache: CacheService) {}

  async issue(userId: string, pending: PendingAction[]): Promise<void> {
    await Promise.all(
      pending.map((p) =>
        this.cache.set(
          key(userId, p.toolCallId),
          fingerprint(p.name, p.arguments),
          { ttl: TTL_SECONDS },
        ),
      ),
    );
  }

  /** True when this exact call was proposed to this person; spent either way. */
  async redeem(userId: string, tc: ToolCall): Promise<boolean> {
    const entry = await this.cache.get<string>(key(userId, tc.id));
    if (!entry) return false;
    await this.cache.delete(key(userId, tc.id));
    return entry === fingerprint(tc.function.name, parseArgs(tc));
  }
}
