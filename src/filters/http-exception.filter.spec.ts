import {
  ArgumentsHost,
  ForbiddenException,
  HttpException,
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

  it('carries what an apply left behind, so a caller can act instead of only read', () => {
    // Measured before this: the filter rebuilt the body field by field and dropped every one of
    // these. The dashboard read the absence of `markedForReuse` as `false` and disabled the retry
    // with "remove them by hand first", directly above the backend's own message saying they WERE
    // marked and the next apply would reuse them. The screen contradicted itself and closed the
    // only way out.
    const { host, sent } = hostFor();
    filter.catch(
      new HttpException(
        {
          statusCode: 500,
          error: 'ApplyLeftApplicationsBehind',
          message:
            'Applying acme/shop failed after 1 application(s) had already been created…',
          branch: 'flui/deploy-3f9a2c1',
          branchDeleted: true,
          committed: false,
          markedForReuse: true,
          strandedApplications: [
            {
              id: 'app-1',
              name: 'shop',
              slug: 'shop-ab12cd',
              unitId: '.',
              branch: 'flui/deploy-3f9a2c1',
              attachedServices: ['db=postgresql'],
            },
          ],
        },
        500,
      ),
      host,
    );

    expect(sent()).toMatchObject({
      error: 'ApplyLeftApplicationsBehind',
      branch: 'flui/deploy-3f9a2c1',
      branchDeleted: true,
      committed: false,
      markedForReuse: true,
      strandedApplications: [
        expect.objectContaining({
          slug: 'shop-ab12cd',
          attachedServices: ['db=postgresql'],
        }),
      ],
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
