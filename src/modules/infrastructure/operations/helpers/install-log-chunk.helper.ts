import { BadRequestException } from '@nestjs/common';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../servers/entities/infrastructure-operations.entity';
import { InstallLogChunkDto } from '../dto/install-log-chunk.dto';

export const INSTALL_LOG_CHUNK_CHARS = 64 * 1024;

const FINISHED = new Set<OperationStatus>([
  OperationStatus.COMPLETED,
  OperationStatus.FAILED,
  OperationStatus.CANCELLED,
]);

/** What one read of the stored log returned; `from` is already clamped to the log's end. */
export interface InstallLogSlice {
  text: string;
  from: number;
  total: number;
  truncated: boolean;
}

export function parseLogCursor(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(
      '`since` must be a whole number of 0 or more: the `next` of the previous read.',
    );
  }
  return value;
}

/** Characters as the database counts them, so the next cursor lands where this piece ended. */
export function logLength(text: string): number {
  return Array.from(text).length;
}

export function installLogChunk(
  operation: Pick<InfrastructureOperationEntity, 'id' | 'status'>,
  slice: InstallLogSlice | null,
  since: number,
): InstallLogChunkDto {
  const finished = FINISHED.has(operation.status);
  if (!slice) {
    return {
      operationId: operation.id,
      status: operation.status,
      text: '',
      since: 0,
      next: 0,
      more: false,
      captured: false,
      truncated: false,
      done: finished,
      note: finished
        ? 'No install log was captured for this operation. Only the first node of a new cluster and a single added node have one.'
        : 'Nothing captured yet: the log is read from the node once it can be reached.',
    };
  }
  const next = slice.from + logLength(slice.text);
  const more = next < slice.total;
  return {
    operationId: operation.id,
    status: operation.status,
    text: slice.text,
    since: slice.from,
    next,
    more,
    captured: true,
    truncated: slice.truncated,
    done: finished && !more,
    note: chunkNote(slice.truncated && !more, since > slice.total),
  };
}

function chunkNote(cutAtLimit: boolean, pastEnd: boolean): string | null {
  if (cutAtLimit) {
    return 'The log reached its size limit; later output from the node was not kept.';
  }
  if (pastEnd) {
    return 'The cursor asked for was past the end of the log; reading resumes from its end.';
  }
  return null;
}
