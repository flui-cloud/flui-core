import {
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../iam/interfaces/policy-engine.interface';
import { McpServerFactory } from './services/mcp-server.factory';
import { credentialFromRequest } from './services/mcp-api.client';

/**
 * Streamable-HTTP MCP endpoint, in-process in flui-api.
 *
 * Serving is per request: `createMcpHandler` classifies the inbound message,
 * asks the factory for a server bound to the authenticated principal, and
 * throws the instance away afterwards. There is no session state, which is what
 * MCP 2026-07-28 assumes — it removes sessions and the `initialize` handshake
 * outright, and carries the client's revision and capabilities in the `_meta`
 * envelope of every request instead.
 *
 * The handler also serves 2025-era clients, on its default `legacy: 'stateless'`
 * posture: a legacy-classified request is answered by a fresh instance from the
 * same factory over a streamable HTTP transport. One factory, both eras — which
 * is why nothing below branches on protocol version.
 *
 * The global JwtAuthGuard authenticates the Bearer token; the MCP server itself
 * gates each tool by scope.
 */
@ApiTags('mcp')
@ApiBearerAuth()
@Controller('mcp')
export class McpController {
  constructor(
    private readonly factory: McpServerFactory,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint (JSON-RPC over POST)',
  })
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.dispatch(req, res);
  }

  /**
   * There is no notification stream here, and saying so costs one line.
   *
   * Handed to a 2025 transport, a GET with `Accept: text/event-stream` does not
   * refuse: it opens a standalone SSE stream and holds the connection open for
   * as long as the client keeps it. Nothing can ever arrive on that stream — a
   * server is built per HTTP request, so whatever a POST's tools emit goes to
   * that POST's own transport, never to this one. The result was an idle
   * connection per client, kept alive for a stream with no writer.
   *
   * 405 is the answer both revisions want, and the answer the SDK's own handler
   * gives for GET and DELETE. Refusing here instead of building a handler for it
   * is the same reply one allocation earlier; keeping the route rather than
   * dropping it is deliberate — a bare 404 makes an SDK client raise, while 405
   * makes it carry on quietly without a stream.
   */
  @Get()
  @ApiOperation({ summary: 'MCP Streamable HTTP endpoint (no stream: 405)' })
  handleGet(@Res() res: Response): void {
    McpController.methodNotAllowed(
      res,
      'This MCP endpoint offers no event stream.',
    );
  }

  /**
   * Nothing to terminate: serving is per request, and 2026-07-28 removes
   * sessions from the protocol altogether. 2025-11-25 explicitly allows 405
   * here for a server that does not let clients end sessions.
   */
  @Delete()
  @ApiOperation({ summary: 'MCP Streamable HTTP endpoint (no sessions: 405)' })
  handleDelete(@Res() res: Response): void {
    McpController.methodNotAllowed(
      res,
      'This MCP endpoint has no sessions to end.',
    );
  }

  private static methodNotAllowed(res: Response, message: string): void {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
  }

  private async dispatch(req: Request, res: Response): Promise<void> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new UnauthorizedException(
        'MCP requires an authenticated principal',
      );
    }

    // Resolved here rather than inside the factory because the fence lives in the
    // policy engine: an agent must inherit exactly the permissions of the person
    // it acts for, never a service identity of its own.
    const access = await this.policy.resolveAccess({
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    });

    // The handler is per request for the same reason the server was: it closes
    // over this principal. `close()` in `finally` releases the modern leg's
    // in-flight instance even when the client hangs up mid-exchange.
    // The credential travels with the principal, and it is the caller's own —
    // read off this very request and replayed on the calls the tools make.
    // Nothing is minted here: an internally issued impersonation token would be
    // a new credential, which is the surface this whole route exists to avoid.
    const credential = credentialFromRequest(req);
    const handler = createMcpHandler(() =>
      this.factory.build(user, credential, access.isSandbox),
    );
    try {
      // Nest's body parser already drained the stream, so the parsed body is
      // handed over explicitly — rebuilding a web Request from a consumed
      // stream would otherwise yield an empty one.
      await toNodeHandler(handler)(req, res, req.body);
    } finally {
      await handler.close();
    }
  }
}
