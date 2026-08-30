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
  /**
   * The other half of a refusal's contract.
   *
   * `code` says what kind of refusal this is; these say what to do about it.
   * The action cycle answers with the request's id, the sentence read at the
   * yes, whether an "always" is on offer and the page that decides — and the
   * client reads exactly those to turn a refusal into a question a person can
   * answer. Rebuilt from a fixed shape, all of them were dropped, and the cycle
   * reached an agent as prose it could only guess at. Every unit test upstream
   * stayed green: they assert the payload the guard throws, not the body that
   * leaves the wire.
   */
  it('carries the rest of a refusal contract, not only its code', () => {
    const { host, sent } = hostFor();
    filter.catch(
      new ForbiddenException({
        statusCode: 403,
        code: 'ACTION_PROPOSAL_PENDING',
        message: 'This call needs a person to allow it first.',
        proposalId: 'p-1',
        action: 'POST /operating-context',
        sentence: 'write a new operating-context note',
        offersAlways: false,
        estimateRef: '/infrastructure/clusters/c1/scale-preview',
        decideUrl: 'http://localhost:4200/agents/requests/p-1',
        expiresAt: '2026-08-26T09:00:00.000Z',
      }),
      host,
    );

    expect(sent()).toMatchObject({
      code: 'ACTION_PROPOSAL_PENDING',
      proposalId: 'p-1',
      action: 'POST /operating-context',
      sentence: 'write a new operating-context note',
      offersAlways: false,
      estimateRef: '/infrastructure/clusters/c1/scale-preview',
      decideUrl: 'http://localhost:4200/agents/requests/p-1',
      expiresAt: '2026-08-26T09:00:00.000Z',
    });
  });

  it('carries nothing a refusal did not name', () => {
    const { host, sent } = hostFor();
    filter.catch(
      new ForbiddenException({
        statusCode: 403,
        code: 'SANDBOX_ROUTE_FORBIDDEN',
        message: 'This is disabled in the Flui sandbox.',
        kubeconfig: 'apiVersion: v1',
        stack: 'at Object.<anonymous>',
      }),
      host,
    );

    expect(sent()).not.toHaveProperty('kubeconfig');
    expect(sent()).not.toHaveProperty('stack');
  });
});
