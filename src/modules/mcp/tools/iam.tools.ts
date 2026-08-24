import { z } from 'zod';
import { defineTool, ToolDef } from './mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { ASSIGNABLE_ROLE_KEYS } from '../../iam/constants/iam-roles';

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

/** How far a grant reaches, in the words the four scope types actually mean. */
// eslint-disable-next-line sonarjs/function-return-type -- a selector is passed through as a predicate, never summarised into a sentence.
function reachOf(
  scopeType?: string,
  scopeRef?: string | null,
  selector?: unknown,
) {
  if (scopeType === 'global') return 'everything on this instance';
  if (scopeType === 'selector') return { selector };
  return `${scopeType} ${scopeRef ?? ''}`.trim();
}

/**
 * A grant, as the model needs to see it: who, what, and where it reaches.
 *
 * The row carries audit columns nothing here can act on, and a list of thirty
 * of them is thirty times the tokens for the four fields that decide anything.
 * `selector` is passed through unflattened because it is a predicate, and a
 * summarised predicate is one an agent would repeat back wrongly.
 */
function grantView(raw: unknown): unknown {
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((r) => {
    const g = r as {
      id?: string;
      principalType?: string;
      principalRef?: string;
      role?: string;
      scopeType?: string;
      scopeRef?: string | null;
      selector?: unknown;
      createdAt?: string;
    };
    return {
      grantId: g.id,
      principal: `${g.principalType}:${g.principalRef}`,
      role: g.role,
      reaches: reachOf(g.scopeType, g.scopeRef, g.selector),
      createdAt: g.createdAt,
    };
  });
}

/**
 * What the model must be told after a grant was written or removed.
 *
 * The delta is NOT recomputed here. `POST /iam/grants` and
 * `DELETE /iam/grants/:id` both answer with one, resolved against the policy
 * engine on either side of the write — so this lifts what the API said rather
 * than deriving a second answer that could disagree with it. A tool that did
 * its own arithmetic would be the third implementation of a rule that has one
 * (`AccessDeltaService`), and the one furthest from the enforcement.
 */
function writtenView(raw: unknown): unknown {
  const r = raw as { id?: string; role?: string; delta?: unknown };
  return {
    grantId: r.id,
    role: r.role,
    grant: grantView(raw),
    impact: r.delta ? deltaView(r.delta) : undefined,
  };
}

const PRINCIPAL_TYPES = ['user', 'group', 'service_account'] as const;

/**
 * Reading the access graph, and — for a credential that was deliberately handed
 * `mcp:iam:write` — changing it.
 *
 * The write half exists on the condition decision 91 was granted under: the
 * scope is in no group but its own, so nothing sweeps it in. What makes it safe
 * is not a check written in this file. `POST /iam/grants` and
 * `DELETE /iam/grants/:id` ask for `iam:assign-role`, `ApiKeyStrategy` re-reads
 * the owning person's identity on every call, and `IamService.assertMayConfer`
 * applies the per-role ladder on top — so **an agent cannot confer a permission
 * its owner does not hold**, and the refusal comes from the same code path a
 * browser would meet. Nothing here re-implements any of it, which is why there
 * is nothing here to get wrong.
 *
 * Requirement 42 applies to this surface as much as to the two others: an agent
 * that takes something away has to be able to say what. Both write tools relay
 * the API's own delta, and `access_grant_remove` insists on it in its
 * description rather than hoping.
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
  /**
   * The list the preview tool always assumed somebody else had read.
   *
   * `access_revocation_preview` takes a grant id and told the model to get it
   * "from the access screen or `flui iam grant list`" — neither of which an
   * external agent has. Without this, the read half of the access area was a
   * tool nobody could call the first time.
   */
  defineTool({
    name: 'access_grant_list',
    routes: ['GET /iam/grants'],
    description:
      'Every access grant on this instance: who holds it, which role, and how far it reaches. Start here to find the `grantId` the other access tools take. Changes nothing.',
    inputSchema: {},
    scope: MCP_SCOPE.IAM_READ,
    run: (_args, ctx) => ctx.api.get('/iam/grants'),
    forModel: grantView,
  }),
  defineTool({
    name: 'access_grant_add',
    routes: ['POST /iam/grants'],
    description:
      'Give a person, a group or a service account a role over this instance, or over part of it. This CHANGES what somebody else can reach — say who is getting what, and where it reaches, before you call it, and repeat the `impact.summary` sentence afterwards. You can never hand out more than the person who issued your credential holds: a role above them is refused, and the refusal names it.',
    inputSchema: {
      principalType: z
        .enum(PRINCIPAL_TYPES)
        .describe(
          'What kind of principal receives it. `user` for a person, `group` for a named group, `service_account` for a machine identity.',
        ),
      principalRef: z
        .string()
        .min(1)
        .describe(
          'Who: the email address for a `user`, the group name for a `group`, the identity id for a `service_account`. Read it from `access_grant_list` rather than guessing.',
        ),
      role: z
        .enum(ASSIGNABLE_ROLE_KEYS as [string, ...string[]])
        .describe(
          'The rung, cumulative from viewer up: viewer reads, operator runs, maintainer changes, owner administers.',
        ),
      scopeType: z
        .enum(['global', 'section', 'cluster', 'selector'])
        .describe(
          'How far it reaches. `global` is the whole instance; `section` one portal section; `cluster` one cluster; `selector` a standing rule over applications matching the attributes in `selector`.',
        ),
      scopeRef: z
        .string()
        .optional()
        .describe(
          'The section key or cluster id, when `scopeType` is `section` or `cluster`. Leave out otherwise.',
        ),
      selector: z
        .object({
          slugs: z.array(z.string()).optional(),
          type: z.enum(['system', 'user']).optional(),
          kind: z.string().optional(),
          clusterId: z.string().optional(),
          clusterName: z.string().optional(),
          provider: z.string().optional(),
          project: z.string().optional(),
          tags: z.array(z.string()).optional(),
          owner: z.string().optional(),
        })
        .optional()
        .describe(
          'Only with `scopeType: selector`. The named attributes are AND-ed, and it is a standing rule: it also covers applications that come to match it later.',
        ),
    },
    scope: MCP_SCOPE.IAM_WRITE,
    run: (args, ctx) => ctx.api.post('/iam/grants', args),
    forModel: writtenView,
  }),
  defineTool({
    name: 'access_grant_remove',
    routes: ['DELETE /iam/grants/:id'],
    description:
      'Remove an access grant. Somebody LOSES access when you call this. Call `access_revocation_preview` first and get the person’s agreement to what it says; afterwards, tell them the `impact.summary` sentence and what `impact` names — the applications, the portal sections and the permissions they no longer reach. An empty `impact.applications` with completeness "unknown" means the inventory could not be read, never that nothing was lost.',
    inputSchema: {
      grantId: z
        .string()
        .min(1)
        .describe('Grant id, as listed by `access_grant_list`'),
    },
    scope: MCP_SCOPE.IAM_WRITE,
    run: (args, ctx) => ctx.api.delete(`/iam/grants/${enc(args.grantId)}`),
    forModel: writtenView,
  }),
];
