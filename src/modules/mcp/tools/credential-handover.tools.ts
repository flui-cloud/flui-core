import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';
import { inTheDashboard, runCommand } from './handover';

/**
 * The credentials an agent may ask for and must never hold.
 *
 * `app_variable_request` proved the shape a year of design argued about: the
 * tool takes no value, returns whether the thing is configured, and hands the
 * person a verb of their own. It was the only one. The ratified sorting
 * (`FABLE_SMISTAMENTO.md` §2) named seven more destinations that reach
 * encrypted storage and had no tool at all — so an agent asked to connect a
 * mail provider or a backup target had nothing to offer but a wall.
 *
 * Seven tools for eight ratified rows: two of them — "the GitHub PAT" and "the
 * packages token" — turn out to name **one** destination in the product.
 * `flui integration connect github` installs the App and stores no PAT; the
 * only personal access token Flui keeps is the GHCR one, because GitHub App
 * tokens cannot read container packages. An eighth tool would have been a tool
 * for a credential that does not exist.
 *
 * **What every one of them refuses to do**, stated once because it is the whole
 * point:
 *
 *  1. **no value argument, ever.** Not optional, not "for automation": an
 *     argument is context, and context is transcript;
 *  2. **it reports WHETHER, never WHAT.** Every result answers "is this
 *     configured", and nothing on this path can answer with the value;
 *  3. **the privileged write is not performed here.** These carry read-tier
 *     scopes and make read calls. The write is the person's, through their own
 *     credential — which is also why an agent key being refused the underlying
 *     route is not a bug to route around.
 *
 * **Three of the six hand over to a screen rather than a command**, and say so
 * plainly instead of inventing a link. See {@link inTheDashboard}: the tool
 * surface reaches the product only through the API, and no route hands back the
 * instance's own public origin. That is a declared gap with a known fix, not a
 * design.
 */

/** Path-segment safety: a value from a model is input, not a literal. */
const enc = encodeURIComponent;

/** What a "still not there" answer says, so an agent parks instead of retrying. */
const STOP_AND_CARRY_ON =
  'This is a state, not a failure: stop here, do not retry, and carry on with everything that does not depend on it.';

export const CREDENTIAL_HANDOVER_TOOLS: ToolDef[] = [
  defineTool({
    name: 'api_key_request',
    routes: ['GET /auth/api-keys'],
    description:
      'Ask a PERSON to mint you an API key — the credential you would present on a later call, or hand to another agent. ' +
      'You must never mint one yourself and there is no argument here that could carry one back: a key is issued once, shown once, and the person keeps it. ' +
      'Say which scopes you need and why; the person decides whether to grant them. ' +
      'Returns the keys that already exist on this account — their names, scopes and whether they are revoked, never their values.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      purpose: z
        .string()
        .describe(
          'What the key is for, in one line. The person reads this before deciding.',
        ),
      scopes: z
        .array(z.string())
        .optional()
        .describe(
          'The mcp:* scopes you need, e.g. ["mcp:app:read"]. Ask for the least that does the job — a scope the issuer does not hold is refused, not trimmed.',
        ),
    },
    run: async (args, ctx) => {
      const existing = await ctx.api.get<
        Array<{
          id?: string;
          name?: string;
          scopes?: string[] | null;
          revoked?: boolean;
        }>
      >('/auth/api-keys');
      const keys = (Array.isArray(existing) ? existing : [])
        .filter((k) => !k.revoked)
        .map((k) => ({ name: k.name, scopes: k.scopes ?? 'no ceiling' }));

      // Named scopes go into the command; `--unscoped` never does. Putting the
      // widest credential the instance can issue into a line an agent relays
      // would make asking for everything the path of least resistance.
      const asked = args.scopes?.length ? args.scopes : undefined;
      const command = [
        'flui auth generate-api-key',
        '--name <name>',
        ...(asked ?? []).map((s) => `--scope ${s}`),
      ].join(' ');

      return {
        purpose: args.purpose,
        requested: asked ?? null,
        existingKeys: keys,
        note:
          (asked
            ? ''
            : "No scopes were named, so the command below has none: a key with no ceiling carries the issuer's full weight and is not something to ask for in passing. ") +
          `The key is shown to the person once and never becomes readable again — not to you, and not to them. ${STOP_AND_CARRY_ON}`,
        ...runCommand(command, 'Mint an API key'),
      };
    },
  }),
  defineTool({
    name: 'ghcr_token_request',
    routes: ['GET /repositories/github-app/packages-pat/status'],
    description:
      'Ask a PERSON to supply the GitHub token Flui uses to pull container images from GHCR (required before `flui deploy` can pull a built image; GitHub App and OAuth tokens cannot read container packages). ' +
      'You must never hold, generate, guess or relay this token: there is no argument for it here. ' +
      'Returns whether one is configured and, if not, the command the person runs themselves — it prompts for the value and stores it encrypted. ' +
      'Reading tells you only WHETHER a token is set and when it expires, never WHAT it is.',
    // Instance scope, not application scope. There is one GHCR token for the
    // whole installation, and offering its state under `app:read` would put
    // instance configuration in front of anyone holding a read grant on one
    // application — including a sandbox guest. The permission-group sentinel
    // is what said so out loud.
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: {},
    run: async (_args, ctx) => {
      const status = await ctx.api.get<{
        configured?: boolean;
        expiresAt?: string | null;
        daysUntilExpiry?: number | null;
        githubLogin?: string;
      }>('/repositories/github-app/packages-pat/status');

      const action = runCommand(
        'flui integration ghcr-pat set',
        'Deliver the GHCR token',
      );
      if (status.configured) {
        return {
          configured: true,
          githubLogin: status.githubLogin,
          expiresAt: status.expiresAt ?? null,
          daysUntilExpiry: status.daysUntilExpiry ?? null,
          note: 'Already configured. The token is not readable from here, by design. To replace or rotate it, the person runs the command below themselves.',
          ...action,
        };
      }
      return {
        configured: false,
        note: `No GHCR token is stored, so pulling a built image will fail. ${STOP_AND_CARRY_ON}`,
        ...action,
      };
    },
  }),

  defineTool({
    name: 'mail_provider_request',
    routes: ['GET /mail/connections'],
    description:
      'Ask a PERSON to connect a mail provider (Scaleway TEM, Brevo, ZeptoMail or an SMTP relay) so this instance can send mail. ' +
      'The provider credential is an API key or a relay password: you must never hold or relay it, and there is no argument for it here. ' +
      'Returns which providers are already connected and, for the one asked about, the command the person runs — it prompts for the credential and never takes it on the command line. ' +
      'Naming a provider is optional; without one this only reports what is connected.',
    scope: MCP_SCOPE.MAIL_READ,
    inputSchema: {
      provider: z
        .enum(['scaleway-tem', 'brevo', 'zeptomail', 'smtp'])
        .optional()
        .describe('Which provider to connect. Never a credential.'),
      scope: z
        .enum(['transactional', 'bulk'])
        .optional()
        .describe(
          'What this sender carries. Never the same account for both: a suspension caused by a mailing list would stop password resets too.',
        ),
    },
    run: async (args, ctx) => {
      const connections =
        await ctx.api.get<
          Array<{ id?: string; provider?: string; scope?: string }>
        >('/mail/connections');
      const existing = Array.isArray(connections) ? connections : [];
      const connected = existing.map((c) => ({
        provider: c.provider,
        scope: c.scope,
      }));

      if (!args.provider) {
        return {
          connected,
          note: 'Name a provider to be handed the command that connects it.',
        };
      }

      const already = existing.some((c) => c.provider === args.provider);
      const command = [
        'flui mail connect',
        args.provider,
        args.scope ? `--scope ${args.scope}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const action = runCommand(command, `Connect ${args.provider}`);

      return {
        provider: args.provider,
        connected,
        alreadyConnected: already,
        note: already
          ? 'Already connected. Its credential is not readable from here. Running the command again replaces it.'
          : `Not connected yet. The command prints where to obtain the credential, then asks for it at a prompt. ${STOP_AND_CARRY_ON}`,
        ...action,
      };
    },
  }),

  defineTool({
    name: 'backup_destination_request',
    routes: ['GET /backup-destinations'],
    description:
      'Ask a PERSON to create a backup destination — the S3-compatible bucket backups are written to. ' +
      'Its access key and secret key are credentials: you must never hold or relay them, and there are no arguments for them here. ' +
      'Returns the destinations that already exist and the command the person runs to add one; the command asks for both keys at a prompt so they never enter a shell history. ' +
      'The non-secret parts (name, provider, endpoint, region, bucket) may be given here and are placed in the command for them.',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {
      name: z.string().optional().describe('Display name. Never a credential.'),
      provider: z
        .enum([
          'hetzner_object_storage',
          'scaleway_object_storage',
          'minio',
          'generic_s3',
        ])
        .optional(),
      endpoint: z.string().optional().describe('S3 endpoint URL.'),
      region: z.string().optional(),
      bucket: z.string().optional(),
    },
    run: async (args, ctx) => {
      const existing = await ctx.api.get<
        Array<{ id?: string; name?: string; bucket?: string }>
      >('/backup-destinations');
      const destinations = (Array.isArray(existing) ? existing : []).map(
        (d) => ({ id: d.id, name: d.name, bucket: d.bucket }),
      );

      // Only the parts that are not secrets. The two keys are absent from this
      // string on purpose, and the command prompts for them.
      const given: Array<[string, string | undefined]> = [
        ['name', args.name],
        ['provider', args.provider],
        ['endpoint', args.endpoint],
        ['region', args.region],
        ['bucket', args.bucket],
      ];
      const command = [
        'flui backup destination create',
        ...given
          .filter(([, value]) => value)
          .map(([flag, value]) => `--${flag} ${value}`),
      ].join(' ');

      const missing = given.filter(([, value]) => !value).map(([flag]) => flag);

      return {
        destinations,
        note:
          missing.length > 0
            ? `Fill in the remaining flags (${missing.join(', ')}) before relaying. The access key and secret key are deliberately not part of this command: it asks for them at a prompt. ${STOP_AND_CARRY_ON}`
            : `The access key and secret key are deliberately not part of this command: it asks for them at a prompt. ${STOP_AND_CARRY_ON}`,
        ...runCommand(command, 'Create the backup destination'),
      };
    },
  }),

  defineTool({
    name: 'provider_credentials_request',
    routes: ['GET /management/providers'],
    description:
      'Ask a PERSON to supply or replace an infrastructure provider credential (Hetzner, Scaleway and the rest) — needed before a cluster can be created, and the same credential a DNS zone on that provider uses. ' +
      'The provider key is a credential: you must never hold or relay it, and there is no argument for it here. ' +
      'Returns which providers are configured and which are not. This one has no command: the person does it in the dashboard, and you relay where.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: {
      provider: z
        .string()
        .optional()
        .describe('Which provider to ask about. Never a credential.'),
    },
    run: async (args, ctx) => {
      const providers = await ctx.api.get<
        Array<{
          name?: string;
          id?: string;
          configured?: boolean;
          enabled?: boolean;
        }>
      >('/management/providers');
      const all = Array.isArray(providers) ? providers : [];
      const seen = all.map((p) => ({
        provider: p.name ?? p.id,
        configured: p.configured ?? false,
        enabled: p.enabled ?? false,
      }));
      const asked = args.provider
        ? seen.find((p) => p.provider === args.provider)
        : undefined;

      return {
        providers: seen,
        ...(args.provider
          ? { provider: args.provider, configured: asked?.configured ?? false }
          : {}),
        note: `A provider credential is stored encrypted and is never readable back. ${STOP_AND_CARRY_ON}`,
        ...inTheDashboard(
          'Management → Providers',
          'they choose the provider and paste its key there',
        ),
      };
    },
  }),

  defineTool({
    name: 'inference_connection_request',
    routes: ['GET /inference/connections'],
    description:
      "Ask a PERSON to connect a model provider so Flui's own AI features can run. " +
      'The provider API key is a credential: you must never hold or relay it, and there is no argument for it here. ' +
      'Returns the connections that exist at instance level. A person may also hold a private connection of their own, which is not listed to anyone else by design — an empty list is not proof that nothing is connected.',
    // Instance scope, for the same reason as the GHCR token above.
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: {},
    run: async (_args, ctx) => {
      const connections = await ctx.api.get<
        Array<{ id?: string; provider?: string; label?: string }>
      >('/inference/connections');
      const shared = (Array.isArray(connections) ? connections : []).map(
        (c) => ({ provider: c.provider, label: c.label }),
      );
      return {
        instanceConnections: shared,
        note:
          'Personal connections are private by design and are not counted here. ' +
          `A connection's key is stored encrypted and never readable back. ${STOP_AND_CARRY_ON}`,
        ...inTheDashboard(
          'Settings → Model providers',
          'they pick a provider and paste its API key there',
        ),
      };
    },
  }),

  defineTool({
    name: 'user_invite_request',
    routes: ['GET /auth/users'],
    description:
      'Ask a PERSON to invite somebody to this instance. The invite link is itself a credential — whoever holds it becomes that account — so it is never returned to you, never shown in a transcript, and there is no argument here that could carry one. ' +
      'Returns whether an account with that email already exists. The person issues the invitation in the dashboard and the link travels to the recipient by mail, not through you.',
    // `mcp:iam:write`, for a tool that only reads. Listing the accounts on this
    // instance is gated on `iam:assign-role`, and `mcp:iam:read` does not carry
    // that verb — so a read scope here would have offered the tool to a
    // credential the route then refuses. The route-permission sentinel is what
    // said so; the alternative was declaring the refusal deliberate and leaving
    // an agent a tool that never works.
    scope: MCP_SCOPE.IAM_WRITE,
    inputSchema: {
      email: z
        .string()
        .describe('Who to invite. An address, never a password or a link.'),
    },
    run: async (args, ctx) => {
      const users = await ctx.api.get<Array<{ email?: string; id?: string }>>(
        `/auth/users?search=${enc(args.email)}`,
      );
      const found = (Array.isArray(users) ? users : []).find(
        (u) => u.email?.toLowerCase() === args.email.toLowerCase(),
      );
      return {
        email: args.email,
        alreadyExists: !!found,
        note: found
          ? 'An account with this address already exists. Re-inviting would mint a fresh link, which the person does deliberately, not you.'
          : `No account with this address yet. ${STOP_AND_CARRY_ON}`,
        ...inTheDashboard(
          'Management → Users',
          'they add the address and send the invitation from there',
        ),
      };
    },
  }),
];
