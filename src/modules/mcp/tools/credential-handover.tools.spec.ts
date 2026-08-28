import { ALL_TOOLS } from './tool-registry';
import { CREDENTIAL_HANDOVER_TOOLS } from './credential-handover.tools';
import { McpToolContext, ToolDef, runTool } from './mcp-tool.util';
import { McpApiCaller } from '../services/mcp-api.client';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { RELAY_ONLY } from './handover';

/**
 * A field name that would be a credential if a model filled it in.
 *
 * Written as names rather than as a review instruction because a review does
 * not run on the next branch. `key` on its own is deliberately absent: a
 * variable's *name* is `key`, and banning the word would ban
 * `app_variable_request`, which is the tool that got this right first.
 */
const READS_AS_A_SECRET =
  /(secret|password|passphrase|credential|access[-_]?key|private[-_]?key|api[-_]?key|\btoken\b|\bpat\b)/i;

function fieldsOf(tool: ToolDef): string[] {
  return Object.keys(tool.inputSchema ?? {});
}

/**
 * The claim the whole delivery design rests on, made checkable over the entire
 * catalogue rather than over the six tools that were written to obey it.
 *
 * Scoping this to the handover family would have been the comfortable version
 * and the useless one: the risk is not that these six grow a `secret` argument,
 * it is that some future tool elsewhere takes one because it was convenient,
 * and nothing says no.
 */
describe('no tool anywhere accepts a credential as an argument', () => {
  it.each(ALL_TOOLS.map((t) => t.name))('%s takes no secret', (name) => {
    const tool = ALL_TOOLS.find((t) => t.name === name) as ToolDef;
    const offending = fieldsOf(tool).filter((f) => READS_AS_A_SECRET.test(f));
    expect(offending).toEqual([]);
  });

  /**
   * Guards the guard. A pattern that matches nothing passes every tool for the
   * wrong reason, and would keep passing after somebody edits it.
   */
  it('recognises the names it exists to catch', () => {
    for (const field of [
      'secret',
      'apiKey',
      'api_key',
      'accessKey',
      'access-key',
      'password',
      'passphrase',
      'token',
      'pat',
      'privateKey',
    ]) {
      expect(READS_AS_A_SECRET.test(field)).toBe(true);
    }
    for (const field of ['key', 'applicationId', 'provider', 'email']) {
      expect(READS_AS_A_SECRET.test(field)).toBe(false);
    }
  });
});

const REPLIES: Record<string, unknown> = {
  '/auth/api-keys': [],
  '/repositories/github-app/packages-pat/status': { configured: false },
  '/mail/connections': [],
  '/backup-destinations': [],
  '/management/providers': [{ name: 'hetzner', configured: false }],
  '/inference/connections': [],
};

function ctxFor(): McpToolContext {
  const reply = (path: string) => {
    const base = path.split('?')[0];
    return Promise.resolve(
      REPLIES[base] ?? (base === '/auth/users' ? [] : {}),
    ) as Promise<never>;
  };
  const api: McpApiCaller = {
    get: reply,
    post: reply,
    put: reply,
    patch: reply,
    delete: reply,
  };
  return {
    user: { userId: 'u1', email: 'agent@flui.cloud' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api,
  } as unknown as McpToolContext;
}

const ARGS: Record<string, Record<string, unknown>> = {
  api_key_request: { purpose: 'read the deploy status nightly' },
  ghcr_token_request: {},
  mail_provider_request: { provider: 'brevo' },
  backup_destination_request: { name: 'nightly' },
  provider_credentials_request: { provider: 'hetzner' },
  inference_connection_request: {},
  user_invite_request: { email: 'bob@acme.com' },
};

async function resultOf(tool: ToolDef): Promise<Record<string, unknown>> {
  const out = await runTool(ctxFor(), tool, ARGS[tool.name]);
  const text = (out as { content?: Array<{ text: string }> }).content?.[0]
    ?.text;
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
}

describe('what a hand-off hands back', () => {
  it('covers every destination the sorting ratified', () => {
    expect(CREDENTIAL_HANDOVER_TOOLS.map((t) => t.name).sort()).toEqual(
      Object.keys(ARGS).sort(),
    );
  });

  /**
   * Either a command the person runs, or the screen they open — never nothing.
   * A hand-off that reports a state and offers no way forward leaves the agent
   * exactly where it was before the tool existed.
   */
  it.each(CREDENTIAL_HANDOVER_TOOLS.map((t) => t.name))(
    '%s tells the person what to do next',
    async (name) => {
      const tool = CREDENTIAL_HANDOVER_TOOLS.find(
        (t) => t.name === name,
      ) as ToolDef;
      const result = await resultOf(tool);
      expect(result.instructions).toBeTruthy();
      expect(result.cliAction ?? result.where).toBeTruthy();
    },
  );

  /**
   * The three prohibitions travel with the command, not with the tool's
   * documentation: a model reads the result it just got far more reliably than
   * a description it saw once at the start of the session.
   */
  it.each([
    'api_key_request',
    'ghcr_token_request',
    'mail_provider_request',
    'backup_destination_request',
  ])('%s carries the relay-only instruction', async (name) => {
    const tool = CREDENTIAL_HANDOVER_TOOLS.find(
      (t) => t.name === name,
    ) as ToolDef;
    expect((await resultOf(tool)).instructions).toBe(RELAY_ONLY);
  });

  /**
   * The one that would be a real leak: `backup destination create` used to take
   * `--access-key` and `--secret-key` as required flags, so a relayed command
   * would have carried two credentials into a shell history. The CLI now
   * prompts for them, and the command this hands over must not name them.
   */
  it('never puts the object-storage keys in the relayed command', async () => {
    const tool = CREDENTIAL_HANDOVER_TOOLS.find(
      (t) => t.name === 'backup_destination_request',
    ) as ToolDef;
    const result = await resultOf(tool);
    const command = (result.cliAction as { command: string }).command;
    expect(command).not.toContain('access-key');
    expect(command).not.toContain('secret-key');
    expect(command).toContain('flui backup destination create');
  });

  /**
   * The widest credential the instance can issue must not be what an agent
   * relays by default. `--unscoped` carries the issuer's whole weight, and
   * putting it in the command would make asking for everything the path of
   * least resistance — the tool says what it is instead, and leaves the flag to
   * a person who types it on purpose.
   */
  it('never relays a command that asks for a key with no ceiling', async () => {
    const tool = CREDENTIAL_HANDOVER_TOOLS.find(
      (t) => t.name === 'api_key_request',
    ) as ToolDef;
    const result = await resultOf(tool);
    const command = (result.cliAction as { command: string }).command;

    expect(command).not.toContain('--unscoped');
    expect(command).toContain('flui auth generate-api-key');
    expect(String(result.note)).toContain('full weight');
  });

  it('puts the scopes it was asked for into the command, and only those', async () => {
    const tool = CREDENTIAL_HANDOVER_TOOLS.find(
      (t) => t.name === 'api_key_request',
    ) as ToolDef;
    const out = await runTool(ctxFor(), tool, {
      purpose: 'read deploy status',
      scopes: ['mcp:app:read'],
    });
    const command = JSON.parse(
      (out as { content: Array<{ text: string }> }).content[0].text,
    ).cliAction.command as string;

    expect(command).toContain('--scope mcp:app:read');
    expect(command).not.toContain('--unscoped');
  });

  /**
   * A personal inference connection is private by design, so an empty list is
   * not evidence of absence. Saying so in the payload is what stops an agent
   * concluding "nothing is connected" and cheerfully asking somebody to connect
   * a second one.
   */
  it('warns that personal inference connections are not counted', async () => {
    const tool = CREDENTIAL_HANDOVER_TOOLS.find(
      (t) => t.name === 'inference_connection_request',
    ) as ToolDef;
    expect(String((await resultOf(tool)).note)).toContain('private by design');
  });
});
