import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

/**
 * `22P02` — invalid_text_representation. Postgres refusing to read a string as
 * the column's type: `invalid input syntax for type uuid: "not-a-uuid"`.
 */
const INVALID_TEXT_REPRESENTATION = '22P02';

/** The value Postgres could not read, from the sentence it wrote about it. */
function offendingValue(message: string): string | undefined {
  return /:\s*"([^"]*)"/.exec(message)?.[1];
}

/**
 * A malformed identifier is not a broken server.
 *
 * `GET /applications/not-a-uuid` passed the path segment to a `uuid` column,
 * Postgres refused it, and the query error reached nobody's handler — so Nest
 * answered **500**. Nothing had broken: the id simply cannot name anything. A
 * live probe of sixteen `:id` routes found **nine** answering that way, and the
 * same defect was already written down against the API-key strategy, where a
 * `varchar` compared to a `uuid` produced a 500 instead of a 401.
 *
 * It is a class, so it is closed as one. The alternative — a `ParseUUIDPipe` on
 * every `:id` — is a hundred edits that must each be remembered, on routes
 * whose identifier is sometimes a slug and sometimes a name, and it would go
 * stale on the first route added without it.
 *
 * **404 or 400, decided by where the value came from.** An unreadable *path*
 * segment is an absence: it names nothing, and saying so is the same answer a
 * well-formed id for a row that does not exist already gets — which is also
 * what keeps a prober from telling the two apart. An unreadable value from a
 * *body* or a *query* is a bad argument, and answering 404 there would tell the
 * caller their target is missing when what is wrong is what they sent.
 *
 * The driver's sentence never leaves. It names the column's type and the table
 * it belongs to, which is a description of the schema handed to whoever sent
 * rubbish. It is logged instead, because a 22P02 raised from a body is often a
 * real bug in a caller worth finding.
 */
@Catch(QueryFailedError)
export class MalformedIdentifierFilter implements ExceptionFilter {
  private readonly logger = new Logger(MalformedIdentifierFilter.name);

  catch(exception: QueryFailedError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const driver = exception.driverError as { code?: string } | undefined;
    if (driver?.code !== INVALID_TEXT_REPRESENTATION) {
      // Every other query failure keeps the behaviour it had: this filter
      // exists for one error code, and widening it would turn a genuine
      // platform fault into a tidy 400 that nobody investigates.
      throw exception;
    }

    const value = offendingValue(exception.message);
    const params = Object.values(request.params ?? {});
    const fromPath = value !== undefined && params.includes(value);

    this.logger.warn(
      `Unreadable identifier on ${request.method} ${request.url} ` +
        `(${fromPath ? 'path parameter' : 'body or query'}): ${exception.message}`,
    );

    const status = fromPath ? 404 : 400;
    response.status(status).json({
      statusCode: status,
      message: fromPath
        ? 'Not found'
        : 'One of the values in this request is not a valid identifier.',
      error: fromPath ? 'Not Found' : 'Bad Request',
      timestamp: new Date().toISOString(),
    });
  }
}
