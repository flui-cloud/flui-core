import { HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

export interface PerKeyLimit {
  name: string;
  ttlMs: number;
  limit: number;
  code: string;
  message: string;
}

/** Counts one more for `key` and refuses with 429 once past the limit. */
export async function countOrRefuse(
  storage: ThrottlerStorage,
  key: string,
  rule: PerKeyLimit,
): Promise<void> {
  const record = await storage.increment(
    key,
    rule.ttlMs,
    rule.limit,
    0,
    rule.name,
  );
  if (record.totalHits <= rule.limit) return;
  throw new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: rule.code,
      message: rule.message,
      retryAfterSeconds: record.timeToExpire,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
