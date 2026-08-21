/* eslint-disable sonarjs/assertions-in-tests --
   Some assertions are supertest's own `.expect(status)`, which throws on a
   mismatch; the rule only recognises a global `expect()`. */

// The factory reaches thirty-odd Nest services and, through them, ESM-only
// packages ts-jest cannot transform. It is replaced wholesale below anyway —
// this suite is about the transport and the tool path, not about wiring — so
// the module is stubbed at the source and the real graph never loads.
jest.mock('../services/mcp-server.factory', () => ({
  McpServerFactory: class {},
}));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpServer } from '@modelcontextprotocol/server';
import * as request from 'supertest';
import { z } from 'zod';
import { McpController } from '../mcp.controller';
import { McpServerFactory } from '../services/mcp-server.factory';
import { POLICY_ENGINE } from '../../iam/interfaces/policy-engine.interface';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  McpToolContext,
  ToolDef,
  runTool,
  toolInputSchema,
} from '../tools/mcp-tool.util';
import { acceptedContent, inputRequired } from './mrtr';

/**
 * What the MCP endpoint actually puts on the wire, driven through the real
 * controller, the real `createMcpHandler` and the real tool execution path.
 * Only the principal and the audit sink are stubbed.
 *
 * This is where section 7's claims are checked rather than assumed: that the
 * fields the revision mandates are stamped by the package and not by us, that
 * `server/discover` names 2026-07-28 without anybody typing the date, that the
 * multi-round-trip leg now travels in the position the specification gives it —
 * and that a 2025-era client, which is all any client is today, is still
 * served.
 */

const USER = {
  userId: 'user-1',
  email: 'agent@flui.cloud',
  isAdmin: false,
} as unknown as AuthenticatedUser;

const AUDIT = { record: jest.fn().mockResolvedValue(undefined) };

const ctx = (): McpToolContext =>
  ({
    user: USER,
    scopes: new Set<string>([MCP_SCOPE.APP_READ, MCP_SCOPE.APP_WRITE]),
    allowDestructive: false,
    audit: AUDIT as never,
    services: {} as never,
    api: {} as never,
    surface: 'mcp',
  }) as McpToolContext;

const alpha: ToolDef = {
  name: 'zz_last',
  description: 'declared last on purpose',
  inputSchema: {},
  scope: MCP_SCOPE.APP_READ,
  run: async () => ({ ok: true }),
};

const beta: ToolDef = {
  name: 'aa_first',
  description: 'declared first on purpose',
  inputSchema: {},
  scope: MCP_SCOPE.APP_READ,
  run: async () => ({ ok: true }),
};

/** The MRTR shape section 5 built the secret hand-off on, in miniature. */
const deliver: ToolDef = {
  name: 'deliver_secret',
  description: 'asks a person for a value the agent must never hold',
  inputSchema: { key: z.string() },
  scope: MCP_SCOPE.APP_WRITE,
  run: async (args: { key: string }, tools) => {
    const given = acceptedContent(tools.mcpReq?.inputResponses, 'value');
    if (!given) {
      return inputRequired({
        inputRequests: {
          value: inputRequired.elicit({
            message: `Value for ${args.key}`,
            requestedSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          }),
        },
        requestState: `key:${args.key}`,
      });
    }
    return { stored: args.key, sawState: tools.mcpReq?.requestState ?? null };
  },
};

const TOOLS = [alpha, beta, deliver];

const SERVER_INFO = { name: 'flui-test', version: '0.0.0' };

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: 'test instructions',
    capabilities: { tools: { listChanged: false } },
  });
  const base = ctx();
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: toolInputSchema(def.inputSchema),
      },
      (args, sdkCtx) => runTool(base, def, args, sdkCtx),
    );
  }
  return server;
}

/**
 * The `_meta` envelope every 2026-07-28 request carries. There is no
 * `initialize` on this revision — the client states its revision and its
 * capabilities on each request instead, and the codec refuses a request that
 * omits them.
 */
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

describe('MCP endpoint on the wire', () => {
  let app: INestApplication;

  /** A modern (2026-07-28) call: envelope in `_meta`, method named in the headers. */
  const modern = (body: {
    id: number;
    method: string;
    params?: Record<string, unknown>;
  }) => {
    const req = request(app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Method', body.method);
    const name = body.params?.name;
    if (typeof name === 'string') req.set('Mcp-Name', name);
    return req.send({
      jsonrpc: '2.0',
      id: body.id,
      method: body.method,
      params: { ...body.params, _meta: ENVELOPE },
    });
  };

  /** A 2025-era call: no envelope, no method headers — what every client speaks today. */
  const legacy = (body: unknown) =>
    request(app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2025-06-18')
      .send(body as object);

  /** The legacy leg answers over SSE; the JSON-RPC message is the `data:` frame. */
  const sse = (raw: string) =>
    JSON.parse(
      raw
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice(6),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: McpServerFactory, useValue: { build: () => buildServer() } },
        {
          provide: POLICY_ENGINE,
          useValue: { resolveAccess: async () => ({ isSandbox: false }) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = USER;
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers tools/list with no initialize handshake, in a stable order', async () => {
    // 2026-07-28 removes `initialize` outright, so a cold `tools/list` is the
    // normal first thing a client says.
    const first = await modern({ id: 1, method: 'tools/list' }).expect(200);
    const second = await modern({ id: 2, method: 'tools/list' }).expect(200);

    const names = (r: { body: { result: { tools: { name: string }[] } } }) =>
      r.body.result.tools.map((t) => t.name);

    // Registration order, not alphabetical: `zz_last` is declared first on
    // purpose, so this test can tell "stable" from "sorted".
    expect(names(first)).toEqual(['zz_last', 'aa_first', 'deliver_secret']);
    expect(names(second)).toEqual(names(first));
  });

  it('stamps the 2026-07-28 result fields the codec owns', async () => {
    // None of these are written anywhere in src/: `resultType`, the cache
    // fields on a cacheable list, and the server identity on every result are
    // the revision's, filled in by the package. Section 3 recorded their
    // absence as a fact; this records their arrival the same way.
    const res = await modern({ id: 3, method: 'tools/list' }).expect(200);
    expect(res.body.result.resultType).toBe('complete');
    expect(res.body.result.ttlMs).toBe(0);
    expect(res.body.result.cacheScope).toBe('private');
    expect(res.body.result._meta['io.modelcontextprotocol/serverInfo']).toEqual(
      SERVER_INFO,
    );
  });

  it('refuses a POST whose headers do not name the method it carries', async () => {
    // `Mcp-Method` / `Mcp-Name` are mandatory on 2026-07-28 POSTs, and the
    // package enforces them at the edge — before any handler of ours runs.
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: { _meta: ENVELOPE },
      })
      .expect(400);
    expect(res.body.error.code).toBe(-32020);
  });

  it('refuses a tools/call whose Mcp-Name disagrees with the body', async () => {
    // The second mandatory header, and the more useful one: it lets a gateway
    // see which tool is being invoked without parsing the body, so the two must
    // not be allowed to disagree.
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json')
      .set('Mcp-Method', 'tools/call')
      .set('Mcp-Name', 'aa_first')
      .send({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'deliver_secret',
          arguments: { key: 'DB_PASSWORD' },
          _meta: ENVELOPE,
        },
      })
      .expect(400);
    expect(res.body.error.code).toBe(-32020);
  });

  it('says 2026-07-28 on server/discover without anybody writing the date', async () => {
    // The revision comes from the package's own supported set: the date
    // appears in comments and in this suite's envelope, never in a value the
    // server computes an answer from.
    const res = await modern({ id: 5, method: 'server/discover' }).expect(200);
    expect(res.body.result.supportedVersions).toEqual(['2026-07-28']);
    expect(res.body.result.capabilities).toEqual({
      tools: { listChanged: false },
    });
    expect(res.body.result._meta['io.modelcontextprotocol/serverInfo']).toEqual(
      SERVER_INFO,
    );
  });

  it('puts an input-required result on the wire, and does not call it an error', async () => {
    const res = await modern({
      id: 6,
      method: 'tools/call',
      params: { name: 'deliver_secret', arguments: { key: 'DB_PASSWORD' } },
    }).expect(200);

    const result = res.body.result;
    expect(result.isError).toBeUndefined();
    expect(result.resultType).toBe('input_required');
    expect(result.requestState).toBe('key:DB_PASSWORD');
    expect(result.inputRequests.value.method).toBe('elicitation/create');
  });

  it('delivers a retry in the specification position, and completes the call', async () => {
    // This is the assertion section 3 could only write inverted: on the v1 SDK
    // these two keys were stripped by a strict params schema before any handler
    // saw them, and the retry had to be smuggled through `_meta`. The bridge is
    // gone with the SDK that forced it.
    const res = await modern({
      id: 7,
      method: 'tools/call',
      params: {
        name: 'deliver_secret',
        arguments: { key: 'DB_PASSWORD' },
        inputResponses: {
          value: { action: 'accept', content: { value: 'hunter2' } },
        },
        requestState: 'key:DB_PASSWORD',
      },
    }).expect(200);

    const result = res.body.result;
    expect(result.resultType).toBe('complete');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.stored).toBe('DB_PASSWORD');
    expect(payload.sawState).toBe('key:DB_PASSWORD');
    // The value the person supplied is never echoed back to the agent.
    expect(result.content[0].text).not.toContain('hunter2');
  });

  it('still serves a 2025-era client, which is every client there is today', async () => {
    // The risk the migration was weighed against. The handler's default legacy
    // posture answers an era-2025 exchange from the same factory, so the
    // handshake and the tool call below are the whole of what a 2025 client
    // does.
    const hello = await legacy({
      jsonrpc: '2.0',
      id: 8,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stdio-bridge', version: '0' },
      },
    }).expect(200);
    expect(sse(hello.text).result.protocolVersion).toBe('2025-06-18');

    const listed = await legacy({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
    }).expect(200);
    expect(
      sse(listed.text).result.tools.map((t: { name: string }) => t.name),
    ).toEqual(['zz_last', 'aa_first', 'deliver_secret']);

    const called = await legacy({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'aa_first', arguments: {} },
    }).expect(200);
    expect(JSON.parse(sse(called.text).result.content[0].text).ok).toBe(true);
  });

  it('cannot ask a stateless 2025 client for input, and says so instead of hanging', async () => {
    // Recorded as a fact, not a wish. On a 2025 connection there is no
    // `resultType` to carry "waiting for a person", so the SDK's legacy shim
    // tries to ask the client directly — and a per-request legacy exchange has
    // no channel to ask on. The call comes back as an error with the reason in
    // it. `input_required` with `isError` off is a 2026-07-28 guarantee, and
    // this is the boundary of it.
    const res = await legacy({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'deliver_secret', arguments: { key: 'DB_PASSWORD' } },
    }).expect(200);

    const result = sse(res.text).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('elicitation/create');
  });

  it('refuses the notification stream instead of holding it open', async () => {
    // Left to a 2025 transport, this GET opens a standalone SSE stream and
    // keeps the connection alive for a stream nothing can ever write to. 405
    // with `Allow: POST` is what both revisions want, and what an SDK client
    // reads as "no stream here" without raising.
    const res = await request(app.getHttpServer())
      .get('/mcp')
      .set('Accept', 'text/event-stream')
      .expect(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('refuses session termination, because there are no sessions', async () => {
    await request(app.getHttpServer()).delete('/mcp').expect(405);
  });
});
