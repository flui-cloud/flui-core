import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { ALL_TOOLS } from './tool-registry';
import { toolInputSchema } from './mcp-tool.util';

/**
 * The real catalogue, through the real 2026-07-28 serving path.
 *
 * Section 3 proved the ordering rule with three stand-in tools and wrote down
 * that it had not run it against the real list, because building the Nest
 * factory drags thirty services and half an ESM graph into the test. The
 * registration loop is not the factory, though — it is five lines — so the
 * catalogue can be registered directly and served for real.
 *
 * Two things are checked here that only the whole list can show: that every
 * tool's zod schema survives the package's JSON-Schema conversion (v2 converts
 * at registration and throws on a shape it cannot express, which would take the
 * server down at boot rather than at the call), and that `tools/list` really is
 * deterministic across the thirty-odd entries the specification cares about.
 */

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'flui', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const def of ALL_TOOLS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: toolInputSchema(def.inputSchema),
      },
      async () => ({ content: [{ type: 'text', text: '{}' }] }),
    );
  }
  return server;
}

async function listTools(): Promise<string[]> {
  const handler = createMcpHandler(() => buildServer());
  try {
    const res = await handler.fetch(
      new Request('http://localhost/api/v1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: ENVELOPE },
        }),
      }),
    );
    const payload = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    return payload.result.tools.map((t) => t.name);
  } finally {
    await handler.close();
  }
}

describe('the real tool catalogue on the 2026-07-28 wire', () => {
  it('registers every tool without the schema conversion refusing one', () => {
    expect(() => buildServer()).not.toThrow();
    expect(ALL_TOOLS.length).toBeGreaterThan(20);
  });

  it('lists them in declaration order, and lists them the same way twice', async () => {
    const declared = ALL_TOOLS.map((d) => d.name);
    const first = await listTools();
    const second = await listTools();

    expect(first).toEqual(declared);
    expect(second).toEqual(first);
    // Deliberately not alphabetical: the specification asks for a stable
    // order, not a sorted one, and the semantic grouping is more use to a
    // model. This fails if anyone "tidies" the registry into sorted order.
    expect(first).not.toEqual([...declared].sort((a, b) => a.localeCompare(b)));
  });
});
