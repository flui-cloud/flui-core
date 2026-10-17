import { UnauthorizedException } from '@nestjs/common';

export const VISITOR_MERGED_CODE = 'VISITOR_MERGED';
export const VISITOR_GONE_CODE = 'VISITOR_GONE';

export function visitorMerged(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: VISITOR_MERGED_CODE,
    message: 'This visit is now part of an account. Sign in again.',
  });
}

export function visitorGone(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: VISITOR_GONE_CODE,
    message: 'This visit has ended. Open the demo again.',
  });
}
