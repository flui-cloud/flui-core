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

    const errorResponse = {
      statusCode: status,
      message: body ? body.message || exception.message : exception.message,
      error: body ? body.error || 'Error' : 'Error',
      ...(code ? { code } : {}),
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(errorResponse);
  }
}
