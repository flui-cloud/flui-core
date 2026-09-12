import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InfrastructureOperationLogEntity } from '../entities/infrastructure-operation-log.entity';
import { InfrastructureOperationsGateway } from '../gateway/infrastructure-operations.gateway';

/** Bootstrap logs are a few hundred KB in practice; this is a safety valve, not the common path. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * The observability-stack branch of the bootstrap script logs generated
 * passwords in cleartext (e.g. "Redis: redis:6379 (password: ...)") — this is
 * captured, stored and downloadable, so it's redacted before either happens.
 * Not exhaustive by design: cheap insurance against the known cases, not a
 * general secret scanner.
 */
const SECRET_VALUE_PATTERN = /((?:password|secret|token)\s*[:=]\s*)(\S+)/gi;

function redactSecrets(text: string): string {
  return text.replace(
    SECRET_VALUE_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted]`,
  );
}

/**
 * Owns the captured install log for a single infrastructure operation:
 * persists chunks as they're tailed off the node and relays them live over
 * the `/infrastructure` gateway. One row per operation — see
 * `InfrastructureOperationLogEntity` for why this is `text`, appended to at
 * the SQL level, rather than a JSON blob.
 */
@Injectable()
export class InstallLogService {
  private readonly logger = new Logger(InstallLogService.name);

  constructor(
    @InjectRepository(InfrastructureOperationLogEntity)
    private readonly logRepository: Repository<InfrastructureOperationLogEntity>,
    private readonly gateway: InfrastructureOperationsGateway,
  ) {}

  /** How many bytes of `sourceFile` have already been captured — where the next remote `tail` should resume. */
  async getOffset(
    operationId: string,
  ): Promise<{ byteOffset: number; truncated: boolean }> {
    const row = await this.logRepository.findOne({
      where: { operationId },
      select: { byteOffset: true, truncated: true },
    });
    return {
      byteOffset: row?.byteOffset ?? 0,
      truncated: row?.truncated ?? false,
    };
  }

  async getFullLog(
    operationId: string,
  ): Promise<InfrastructureOperationLogEntity | null> {
    return this.logRepository.findOne({ where: { operationId } });
  }

  /**
   * Append newly-tailed bytes, relay them live, and stop growing the stored
   * content once the cap is hit (the offset still advances, so the tail loop
   * keeps skipping past bytes it has already read).
   */
  async appendChunk(
    operationId: string,
    resourceId: string,
    chunk: string,
    sourceFile: string,
  ): Promise<void> {
    if (!chunk) return;
    chunk = redactSecrets(chunk);

    let row = await this.logRepository.findOne({ where: { operationId } });
    if (!row) {
      row = await this.logRepository.save(
        this.logRepository.create({ operationId, sourceFile }),
      );
    }
    // Callers already stop tailing once `getOffset` reports `truncated`; this
    // guards the (harmless but pointless) case of one more chunk arriving
    // before that check runs.
    if (row.truncated) return;

    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    const storedBytes = Buffer.byteLength(row.content, 'utf8');
    const remaining = MAX_LOG_BYTES - storedBytes;
    const toStore = remaining >= chunkBytes ? chunk : chunk.slice(0, remaining);
    const nowTruncated = toStore.length < chunk.length;

    await this.logRepository
      .createQueryBuilder()
      .update(InfrastructureOperationLogEntity)
      .set({
        content: () => 'content || :toStore',
        byteOffset: () => '"byteOffset" + :chunkBytes',
        truncated: nowTruncated,
      })
      .where('"operationId" = :operationId', { operationId })
      .setParameters({ toStore, chunkBytes })
      .execute();

    if (nowTruncated) {
      this.logger.warn(
        `Install log for operation ${operationId} hit the ${MAX_LOG_BYTES} byte cap — further output is dropped`,
      );
    }

    if (toStore) {
      this.gateway.emitLogChunk(operationId, resourceId, {
        operationId,
        resourceId,
        chunk: toStore,
        timestamp: new Date(),
      });
    }
  }
}
