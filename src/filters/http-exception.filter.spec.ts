import {
  ArgumentsHost,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

const hostFor = (): {
  host: ArgumentsHost;
  sent: () => Record<string, unknown>;
} => {
  let body: Record<string, unknown> = {};
  const response = {
    status: () => response,
    json: (payload: Record<string, unknown>) => {
      body = payload;
      return response;
    },
  };
  return {
    host: {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost,
    sent: () => body,
  };
};

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  // Clients are told to branch on `code`; the filter used to drop it, so every
  // such branch fell through to matching on prose.
  it('keeps the machine-readable code a thrower set', () => {
    const { host, sent } = hostFor();
    filter.catch(
      new ForbiddenException({
        statusCode: 403,
        code: 'SANDBOX_ROUTE_FORBIDDEN',
        message: 'This is disabled in the Flui sandbox.',
      }),
      host,
    );

    expect(sent()).toMatchObject({
      statusCode: 403,
      code: 'SANDBOX_ROUTE_FORBIDDEN',
      message: 'This is disabled in the Flui sandbox.',
    });
  });

  it('adds no code when the thrower set none', () => {
    const { host, sent } = hostFor();
    filter.catch(new NotFoundException('Cluster not found'), host);

    expect(sent()).toMatchObject({
      statusCode: 404,
      message: 'Cluster not found',
    });
    expect(sent()).not.toHaveProperty('code');
  });

  it('ignores a code that is not a string', () => {
    const { host, sent } = hostFor();
    filter.catch(
      new ForbiddenException({ statusCode: 403, code: { nested: true } }),
      host,
    );

    expect(sent()).not.toHaveProperty('code');
  });
});
