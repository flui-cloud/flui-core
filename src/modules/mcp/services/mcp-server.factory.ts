import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  McpServer,
  createRequestStateCodec,
  type RequestStateCodec,
} from '@modelcontextprotocol/server';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { Actor } from '../../auth/utils/actor-context';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScopeResolver } from './mcp-scope.resolver';
import { ForwardedCredential, McpApiClient } from './mcp-api.client';
import {
  McpToolContext,
  isExecutable,
  runTool,
  toolInputSchema,
} from '../tools/mcp-tool.util';
import { ALL_TOOLS } from '../tools/tool-registry';
import { isOfferedToGuest } from './sandbox-tool-visibility';

export const MCP_SERVER_NAME = 'flui';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_SERVER_INSTRUCTIONS =
  'Flui: deploy and operate applications on your own clusters. Tools are gated by the scopes of the principal whose token you are using.';

/**
 * Builds a stateless MCP server scoped to one authenticated principal.
 *
 * It injects no domain service any more, and that absence is the point: every
 * tool reaches the product through `ctx.api`, which is the Flui API called over
 * HTTP as the caller. What used to be thirty-one constructor arguments — thirty-one
 * ways to walk past a guard — is now one caller bound to one credential. The
 * principal's resolved scopes and the destructive-enablement flag are captured
 * per request so every tool gates and audits against the caller, not shared state.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly resolver: McpScopeResolver,
    private readonly audit: McpAuditRepository,
    private readonly api: McpApiClient,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * The HMAC key for `requestState`: an HKDF subkey of the platform key, not
   * the platform key itself — one secret, two cryptographic purposes, separated
   * by domain so a weakness in one is not a weakness in the other.
   *
   * Derived once. It is the same on every replica, because `ENCRYPTION_KEY` is
   * platform-wide — and it must be, since the replica that verifies an echoed
   * state is rarely the one that minted it.
   */
  private readonly requestStateKey =
    this.encryption.deriveSubkey('mcp.requestState');

  /**
   * One codec per request, because the binding is the principal of that
   * request: a state minted for one caller is refused when echoed by another.
   * The package stores the binding as a domain-separated HMAC tag, so the user
   * id never travels on the wire.
   *
   * What this does NOT change: a tool still reads which application and which
   * key it is acting on from its validated arguments on every round, never from
   * the state. Signing removes the sign that said "this looks safe"; it does not
   * promote the state to a source of authority.
   */
  private codecFor(user: AuthenticatedUser): RequestStateCodec {
    return createRequestStateCodec({
      key: this.requestStateKey,
      bind: () => user.userId,
    });
  }

  build(
    user: AuthenticatedUser,
    credential: ForwardedCredential,
    isSandbox = false,
    actor?: Actor,
  ): McpServer {
    const requestStateCodec = this.codecFor(user);
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      {
        // `server/discover` (mandatory from 2026-07-28, which drops the
        // `initialize` handshake) is answered by the SDK from these two
        // fields plus the revisions it actually serves. Nothing here names a
        // revision: the day the package moves, the discovery document moves
        // with it instead of repeating a date somebody typed.
        instructions: MCP_SERVER_INSTRUCTIONS,
        // An assertion, not a default: only tools are registered and nothing on
        // this server ever publishes a change event, so the list never changes
        // under a client that cached it.
        //
        // It is also the answer to `subscriptions/listen`, which is served and
        // has no writer behind it. The acknowledgement declares
        // `notifications: {}` — "you may listen; the set of things I publish is
        // empty" — which for a conforming client is exactly true. Capping it
        // instead (`maxSubscriptions: 0`) would answer "Subscription limit
        // reached", an invitation to retry that is a lie. Between a silent
        // stream that tells the truth and a refusal that does not, the silent
        // one. The day `listChanged` becomes true the stream becomes real and
        // the question disappears by itself.
        capabilities: { tools: { listChanged: false } },
        // Runs before every handler on every round that echoes a state — the
        // legacy 2025 shim included — and throws on a tampered, expired or
        // re-bound value, which the seam answers as the frozen `-32602`. Until
        // this existed the state came back raw and unverified, deliberately
        // trusted with nothing.
        requestState: { verify: requestStateCodec.verify },
      },
    );

    const ctx: McpToolContext = {
      user,
      scopes: this.resolver.resolve(user, isSandbox),
      allowDestructive:
        this.config.get<string>('MCP_ALLOW_DESTRUCTIVE') === 'true',
      surface: 'mcp',
      // Bound once per request to the credential that arrived with it. The
      // token never reaches a tool body: what tools get is a caller that
      // already speaks as the principal.
      api: this.api.for(credential, 'mcp'),
      audit: this.audit,
      // Passed in rather than derived here: which api_keys row authenticated
      // the request is on the request and deliberately not on the principal.
      actor,
      requestStateCodec,
    };

    for (const def of ALL_TOOLS) {
      // A tool this principal can never execute is not advertised at all: listing it
      // costs the agent context, invites a plan built around it, and pays back only a
      // refusal. runGated still guards execution — this only trims what is offered.
      if (!isExecutable(ctx, def)) continue;
      // The scope says how much of the toolbox; the fence says which of it a
      // guest would actually be answered with. Both are needed, and only the
      // second knows that a `200` full of example backups is worse for a model
      // than a refusal.
      if (isSandbox && !isOfferedToGuest(def)) continue;

      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: toolInputSchema(def.inputSchema),
        },
        (args, sdkCtx) => runTool(ctx, def, args, sdkCtx),
      );
    }

    return server;
  }
}
