import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const body =
      typeof exceptionResponse === 'object'
        ? (exceptionResponse as Record<string, unknown>)
        : null;

    /**
     * The machine-readable half of a refusal.
     *
     * Callers are told to branch on it — the sandbox entrance picks its wording
     * from `SANDBOX_FULL` versus `SANDBOX_CLAIM_LIMIT`, and the interface tells a
     * fenced-off area from a broken one by `SANDBOX_ROUTE_FORBIDDEN`. This filter
     * rebuilt every error from a fixed shape and dropped it, so every one of
     * those branches was silently falling through to the prose.
     */
    const code = typeof body?.code === 'string' ? body.code : undefined;

    /**
     * The rest of a refusal's contract, carried through by name.
     *
     * `code` alone says *what kind* of refusal this is; these say *what to do
     * about it*, and a refusal that keeps the first and drops the second is a
     * sentence with its verb removed. The action cycle is the case that proves
     * it: the guard raises a request and answers with its id, the sentence read
     * at the yes, whether an "always" is on offer, and the page that decides —
     * and a client reads exactly those to turn a refusal into a question a
     * person can answer. Rebuilt from a fixed shape, every one of them was
     * dropped, so the cycle reached an agent as prose it could only guess at.
     *
     * `estimateRef` is carried because the reader turns it into a boolean and
     * keeps the reference on this side of the guard — the fact that a price
     * exists crosses, the path to it does not. `consequence` crosses whole: it
     * is a sentence written for a person to read, and it is the one thing an
     * agent parked on a wait can usefully repeat.
     *
     * Named one by one rather than spreading the body: an error body is
     * assembled next to the code that throws it and may hold whatever was in
     * hand there. This filter is the last thing between that and the wire.
     */
    const CARRIED = [
      'proposalId',
      'action',
      'sentence',
      'offersAlways',
      'estimateRef',
      'consequence',
      'decideUrl',
      'expiresAt',
    ] as const;
    const carried: Record<string, unknown> = {};
    for (const field of CARRIED) {
      if (body?.[field] !== undefined) carried[field] = body[field];
    }

    const errorResponse = {
      statusCode: status,
      message: body ? body.message || exception.message : exception.message,
      error: body ? body.error || 'Error' : 'Error',
      ...(code ? { code } : {}),
      ...carried,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(errorResponse);
  }
}
