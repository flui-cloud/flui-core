import { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { MalformedIdentifierFilter } from './malformed-identifier.filter';

function hostFor(params: Record<string, string>): {
  host: ArgumentsHost;
  sent: { status?: number; body?: any };
} {
  const sent: { status?: number; body?: any } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const request = { params, method: 'GET', url: '/applications/not-a-uuid' };
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost,
    sent,
  };
}

function queryError(message: string, code?: string): QueryFailedError {
  const error = new QueryFailedError('select 1', [], new Error(message));
  (error as unknown as { driverError: { code?: string } }).driverError = {
    code,
  };
  (error as { message: string }).message = message;
  return error;
}

const UNREADABLE_UUID =
  'invalid input syntax for type uuid: "not-a-uuid" in table "applications"';

describe('an identifier the database cannot read', () => {
  const filter = new MalformedIdentifierFilter();

  /**
   * The whole point. Nine of sixteen probed `:id` routes answered 500 to a
   * malformed segment — and a 500 says the server broke, when what happened is
   * that an id named nothing.
   */
  it('answers a path segment as an absence, not as a fault', () => {
    const { host, sent } = hostFor({ id: 'not-a-uuid' });
    filter.catch(queryError(UNREADABLE_UUID, '22P02'), host);

    expect(sent.status).toBe(404);
    expect(sent.body.message).toBe('Not found');
  });

  /**
   * The same value arriving in a body is a bad argument, not a missing row.
   * Answering 404 there would tell the caller their target does not exist when
   * what is wrong is what they sent.
   */
  it('answers a value that is not in the path as a bad argument', () => {
    const { host, sent } = hostFor({ id: 'a-real-id' });
    filter.catch(queryError(UNREADABLE_UUID, '22P02'), host);

    expect(sent.status).toBe(400);
    expect(sent.body.message).toContain('not a valid identifier');
  });

  /**
   * The refusal must not become a description of the schema. The driver names
   * the column's type and its table, and handing that back rewards sending
   * rubbish with a map.
   */
  it('never repeats what the driver said', () => {
    const { host, sent } = hostFor({ id: 'not-a-uuid' });
    filter.catch(queryError(UNREADABLE_UUID, '22P02'), host);

    const body = JSON.stringify(sent.body);
    expect(body).not.toContain('uuid');
    expect(body).not.toContain('applications');
    expect(body).not.toContain('not-a-uuid');
  });

  /**
   * One error code, deliberately. A filter that tidied every query failure into
   * a 400 would turn a genuine platform fault into something nobody looks at.
   */
  it('lets every other query failure through untouched', () => {
    const { host } = hostFor({ id: 'x' });
    const other = queryError('deadlock detected', '40P01');

    expect(() => filter.catch(other, host)).toThrow(other);
  });

  it('lets a query failure with no driver code through', () => {
    const { host } = hostFor({ id: 'x' });
    const bare = queryError('connection terminated');

    expect(() => filter.catch(bare, host)).toThrow(bare);
  });
});
