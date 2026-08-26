import type { Request } from 'express';
import {
  McpApiClient,
  McpApiError,
  credentialFromRequest,
  hasCredential,
} from './mcp-api.client';
import {
  AGENT_SURFACE_HEADER,
  agentSurfaceOf,
} from '../../auth/utils/actor-surface';

/**
 * The credential seam of strada B.
 *
 * Two claims are load-bearing and both are asserted here rather than described:
 * that nothing on this path MINTS a credential (whatever authenticated the
 * inbound request is what goes back out, byte for byte), and that a refusal
 * which came from a guard stays distinguishable from every other failure once
 * HTTP has flattened it into a status and a sentence.
 */
describe('McpApiClient — the caller carries the caller credential', () => {
  describe('credentialFromRequest', () => {
    it('forwards the Authorization header verbatim and invents nothing', () => {
      const req = {
        headers: { authorization: 'Bearer abc.def.ghi' },
      } as unknown as Request;

      const credential = credentialFromRequest(req);

      expect(credential.authorization).toBe('Bearer abc.def.ghi');
      expect(credential.sessionCookie).toBeUndefined();
      expect(hasCredential(credential)).toBe(true);
    });

    it('picks the session cookie out of the Cookie header, and nothing else', () => {
      const req = {
        headers: { cookie: 'other=keep-out; flui_session=jwt-value; a=b' },
      } as unknown as Request;

      const credential = credentialFromRequest(req);

      expect(credential.sessionCookie).toBe('jwt-value');
      // The point of reading one cookie rather than replaying the header: an
      // unrelated cookie has no business travelling to a Flui route.
      expect(JSON.stringify(credential)).not.toContain('keep-out');
    });

    it('reports no credential rather than substituting one', () => {
      const credential = credentialFromRequest({
        headers: {},
      } as unknown as Request);

      expect(hasCredential(credential)).toBe(false);
      expect(credential.authorization).toBeUndefined();
    });
  });

  /**
   * The one hop the surface has to survive.
   *
   * A tool reaches the product by calling this very process over loopback, and
   * until now only the credential travelled. The credential says *who*; it
   * cannot say that a model wrote these arguments — and for the portal's
   * assistant, whose credential is the person's own browser session, that is
   * the entire question the action cycle needs answered.
   */
  describe('the surface travels with the credential', () => {
    const sent = async (surface?: 'mcp' | 'assistant') => {
      const client = new McpApiClient({ get: () => undefined } as never);
      const request = jest.fn().mockResolvedValue({ status: 200, data: {} });
      (client as unknown as { http: { request: unknown } }).http = { request };
      await client
        .for({ authorization: 'Bearer t' }, surface)
        .post('/applications/app-1/deploy');
      return (request.mock.calls[0][0] as { headers: Record<string, string> })
        .headers;
    };

    it('declares the assistant, and the far side can check it is us', async () => {
      const headers = await sent('assistant');
      expect(agentSurfaceOf(headers)).toBe('assistant');
    });

    it('declares the MCP server the same way', async () => {
      expect(agentSurfaceOf(await sent('mcp'))).toBe('mcp');
    });

    it("declares nothing for a caller that is not a tool — the person's own", async () => {
      // The decision route is reached on exactly such a caller. Declaring a
      // surface there would make the assistant able to answer its own request.
      const headers = await sent();
      expect(headers[AGENT_SURFACE_HEADER]).toBeUndefined();
      expect(headers.Authorization).toBe('Bearer t');
    });
  });

  describe('a surface that forwarded nothing', () => {
    it('fails loudly instead of falling back to an in-process call', async () => {
      const client = new McpApiClient({ get: () => undefined } as never);

      // No fallback on purpose: a tool that quietly stopped going through the
      // guards would look exactly like one that still did.
      await expect(
        client.for({}).get('/applications/a1'),
      ).rejects.toMatchObject({ code: 'MCP_NO_FORWARDED_CREDENTIAL' });
    });
  });

  describe('McpApiError.agentMessage — the behavioural note HTTP would have lost', () => {
    const err = (status: number, detail = 'nope', code?: string) =>
      new McpApiError(status, detail, 'GET', '/applications/a1', code);

    it('names a 403 as access control, NOT as a scope, and says not to retry', () => {
      const message = err(
        403,
        "Not allowed to app:read on application 'other'",
      ).agentMessage;

      expect(message).toContain('Refused by Flui access control (HTTP 403)');
      expect(message).toContain('NOT a scope problem');
      expect(message).toMatch(/Do NOT retry/);
      expect(err(403).isAccessRefusal).toBe(true);
    });

    it('keeps the machine-readable code when the API sent one', () => {
      expect(
        err(403, 'fenced off', 'SANDBOX_ROUTE_FORBIDDEN').agentMessage,
      ).toContain('[code: SANDBOX_ROUTE_FORBIDDEN]');
    });

    it('explains a 401 as the caller own credential, never as a Flui one', () => {
      const message = err(401, 'jwt expired').agentMessage;

      // The honest answer to the expiry case: Flui cannot refresh somebody
      // else's token, so it says so instead of pretending to recover.
      expect(message).toContain('YOUR OWN credential and never mints one');
      expect(message).toMatch(/fresh credential/);
      expect(err(401).isAccessRefusal).toBe(false);
    });

    it('tells a 404 apart from a refusal: look it up, do not retry the id', () => {
      const message = err(404, 'Application not found').agentMessage;
      expect(message).toContain('Not found (HTTP 404)');
      expect(message).toMatch(/look it up first/);
    });

    it('allows exactly one retry on a platform-side failure', () => {
      expect(err(502, 'bad gateway').agentMessage).toMatch(/At most ONE retry/);
    });

    it('warns that a call which never answered MAY still have been applied', () => {
      const timeout = new McpApiError(
        undefined,
        'timeout of 120000ms exceeded',
        'PATCH',
        '/applications/a1/replicas',
        undefined,
        'timeout of 120000ms exceeded',
      );

      expect(timeout.agentMessage).toMatch(/MAY still have been applied/);
      expect(timeout.isAccessRefusal).toBe(false);
    });
  });
});
