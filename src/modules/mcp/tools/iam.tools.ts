import { z } from 'zod';
import { defineTool, ToolDef } from './mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';

const enc = encodeURIComponent;

/**
 * What the model should be told about an access change, and in what order.
 *
 * The sentence first, because it is the thing an agent has to repeat to the
 * person. Then the shape of the loss. `coverage` is turned into a phrase rather
 * than passed through as a token: a model reading `"exact"` beside an empty
 * list draws the same wrong conclusion a screen would, and the one thing this
 * tool exists to prevent is an agent saying "nothing will be lost" when the
 * truthful answer was "not known" or "not everything is listed".
 */
function deltaView(raw: unknown): unknown {
  const d = raw as {
    principal?: { type?: string; ref?: string };
    summary?: string;
    losesNothing?: boolean;
    losesEverything?: boolean;
    principalIsPlatformAdmin?: boolean;
    coverage?: string;
    sectionsClosed?: { key?: string }[];
    sectionsDowngraded?: { key?: string }[];
    applicationsLost?: { slug?: string; clusterName?: string }[];
    applicationsLostCount?: number;
    permissionsLost?: string[];
    note?: string;
  };
  const listed = d.applicationsLost ?? [];
  const total = d.applicationsLostCount ?? 0;
  return {
    principal: `${d.principal?.type}:${d.principal?.ref}`,
    summary: d.summary,
    applications:
      d.coverage === 'unknown'
        ? 'unknown — the application inventory could not be read, so do NOT tell the person nothing will be lost'
        : {
            count: total,
            named: listed.map((a) => `${a.slug} (${a.clusterName})`),
            ...(total > listed.length
              ? { andMore: total - listed.length }
              : {}),
            completeness:
              d.coverage === 'snapshot'
                ? 'these are the applications that match TODAY; the scope is a standing rule, so it also covers whatever matches later'
                : 'the scope named these applications, so this list is the whole of it',
          },
    sectionsClosed: (d.sectionsClosed ?? []).map((s) => s.key),
    sectionsMadeReadOnly: (d.sectionsDowngraded ?? []).map((s) => s.key),
    permissionsLost: d.permissionsLost ?? [],
    losesEverything: d.losesEverything,
    onlyAdds: d.losesNothing,
    platformAdminSoNothingMoves: d.principalIsPlatformAdmin,
    note: d.note,
  };
}

/**
 * Reading the access graph — and only reading it.
 *
 * There are no delegation *write* tools on MCP, deliberately: nothing in this
 * catalogue confers or revokes a role. What the requirement asks of this
 * surface is therefore the half that applies to it — an agent asked "what
 * happens if we take Bob off this?" must be able to answer with the API's own
 * arithmetic instead of guessing from a list of grants.
 */
export const IAM_TOOLS: ToolDef[] = [
  defineTool({
    name: 'access_revocation_preview',
    routes: ['GET /iam/grants/:id/revocation-preview'],
    description:
      'What the holder of an access grant would STOP being able to reach if that grant were removed — which applications, which portal sections, which permissions. Changes nothing. Read this before advising anyone to remove a grant, and repeat the `summary` sentence to the person. Two readings you must not collapse: `completeness` says whether the listed applications are the whole story or only what matches today, and an "unknown" applications field means the inventory could not be read — it NEVER means nothing would be lost.',
    inputSchema: {
      grantId: z
        .string()
        .min(1)
        .describe(
          'Grant id, as listed by the access screen or `flui iam grant list`',
        ),
    },
    scope: MCP_SCOPE.IAM_READ,
    run: (args, ctx) =>
      ctx.api.get(`/iam/grants/${enc(args.grantId)}/revocation-preview`),
    forModel: deltaView,
  }),
];
