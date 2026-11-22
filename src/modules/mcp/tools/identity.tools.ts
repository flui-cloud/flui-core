import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

const enc = encodeURIComponent;
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/);

/**
 * Sign-in for the users of a customer's own apps, on an identity install of
 * theirs (the Zitadel catalog entry). Never the identity provider that runs
 * Flui itself.
 */
export const IDENTITY_TOOLS: ToolDef[] = [
  defineTool({
    name: 'identity_installs_list',
    routes: ['GET /identity/installs'],
    description:
      'List the identity installs you can read — the Zitadel installs from the catalog that sign in the users of your own apps. Each has the identityInstallId the other identity tools take, its issuer address, and managed=false when it predates the key Flui manages it with (reinstall it to manage it from Flui).',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/identity/installs'),
  }),
  defineTool({
    name: 'identity_users_list',
    routes: ['GET /identity/installs/:installId/users'],
    description:
      'List the people who can sign in to the apps connected to an identity install (a Zitadel install from the catalog; installId is its catalog install id). Each has an id, username, email and state (active, invited, blocked, locked). The list can trail a change by a few seconds.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { installId: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/identity/installs/${enc(args.installId)}/users`),
  }),
  defineTool({
    name: 'identity_user_invite',
    routes: ['POST /identity/installs/:installId/users'],
    description:
      'Invite a person to an identity install. The identity server mails the invitation through the email sender it is configured with; the person sets their own password. Ask the person for the email address — never guess one.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      installId: z.string(),
      email: z.email(),
      givenName: z.string().min(1),
      familyName: z.string().min(1),
    },
    run: (args, ctx) =>
      ctx.api.post(`/identity/installs/${enc(args.installId)}/users`, {
        email: args.email,
        givenName: args.givenName,
        familyName: args.familyName,
      }),
  }),
  defineTool({
    name: 'identity_user_block',
    routes: [
      'POST /identity/installs/:installId/users/:userId/block',
      'POST /identity/installs/:installId/users/:userId/unblock',
    ],
    description:
      'Stop a person from signing in to the apps of an identity install (blocked=true), or let them in again (blocked=false). Take the userId from identity_users_list.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      installId: z.string(),
      userId: z.string(),
      blocked: z.boolean(),
    },
    run: async (args, ctx) => {
      await ctx.api.post(
        `/identity/installs/${enc(args.installId)}/users/${enc(args.userId)}/${args.blocked ? 'block' : 'unblock'}`,
      );
      return { userId: args.userId, blocked: args.blocked };
    },
  }),
  defineTool({
    name: 'app_identity_get',
    routes: ['GET /applications/:id/identity'],
    description:
      'Which identity install an application signs its users in with: issuer, client id, the addresses it returns to and the variable names it reads. null when it uses none. Never the client secret.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.get(`/applications/${enc(args.id)}/identity`),
  }),
  defineTool({
    name: 'app_identity_connect',
    routes: ['PUT /applications/:id/identity'],
    description:
      'Sign an application’s users in with an identity install. Flui makes a client for the application there and hands the application only three variables — the issuer, client id and client secret (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET unless envNames says otherwise) — then redeploys it. redirectPaths are paths on the application’s own address the person comes back to after sign-in (for example /auth/callback); ask the person which path their app uses.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      identityInstallId: z.string(),
      redirectPaths: z.array(z.string().startsWith('/')).min(1).max(10),
      envNames: z
        .object({
          issuer: envName.optional(),
          clientId: envName.optional(),
          clientSecret: envName.optional(),
        })
        .optional(),
    },
    run: (args, ctx) =>
      ctx.api.put(`/applications/${enc(args.id)}/identity`, {
        identityInstallId: args.identityInstallId,
        redirectPaths: args.redirectPaths,
        envNames: args.envNames,
      }),
  }),
  defineTool({
    name: 'app_identity_disconnect',
    routes: ['DELETE /applications/:id/identity'],
    description:
      'Stop signing an application’s users in with its identity install: its client there is deleted, the three variables are removed and the application is redeployed. Its users stay in the identity install.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: async (args, ctx) => {
      await ctx.api.delete(`/applications/${enc(args.id)}/identity`);
      return { id: args.id, disconnected: true };
    },
  }),
];
