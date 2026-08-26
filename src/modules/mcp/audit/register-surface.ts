import { AgentSurface } from '../../auth/utils/actor-surface';

/**
 * Which door a register row came through — and the answer to the question the
 * table's name asks and cannot answer.
 *
 * `mcp_tool_call_logs` was written by the MCP server and by nothing else, so
 * "the surface" and "the register" were the same noun and neither needed
 * naming. They are not the same noun: an agent credential presented to `curl`
 * meets exactly the guards the MCP server's own loopback call meets — that is
 * the property the action cycle is built on — and until now it left no row at
 * all. The register is the **credential's**, so the surface becomes a fact
 * *about a row* rather than the identity of the table.
 *
 * The name of the table stays as it is. Renaming it under `synchronize: true`
 * drops the old one with its rows in it, and a register that loses its history
 * to a rename is worse than a register with a dated name. This column is how
 * the truth gets told without the rename.
 *
 * `mcp` and `assistant` are {@link AgentSurface} — the same two names the
 * loopback hop already carries, aliased rather than re-spelled so the two
 * cannot drift. `api` is the third, and it is defined by absence: no surface
 * was declared on the request, so nothing ran between the credential and the
 * door.
 */
export const REGISTER_SURFACE = {
  MCP: 'mcp',
  ASSISTANT: 'assistant',
  API: 'api',
} as const satisfies Record<string, AgentSurface | 'api'>;

export type RegisterSurface =
  (typeof REGISTER_SURFACE)[keyof typeof REGISTER_SURFACE];

/**
 * The rows written before this column existed.
 *
 * Read exactly like `ACTOR_KIND_UNKNOWN`, and for the same reason: a null here
 * is not a claim that the call came through the API, it is the absence of the
 * claim. It is askable as its own bucket and folded into none of the three.
 */
export const REGISTER_SURFACE_UNKNOWN = 'unknown';

/**
 * What the `scope` column says for a row whose route declares no permission.
 *
 * On the two agentic surfaces that column holds the `mcp:*` scope the tool was
 * gated on. A call that arrives straight at a route has no tool and no scope;
 * what it has is whatever `@RequirePermission` the route declares, which is the
 * permission the gate three doors up actually checked — read from the same
 * metadata, so it is a record and not a reconstruction.
 *
 * When the route declares none, the gate checked nothing and there is no
 * permission to name. This word is said instead of a plausible one, because a
 * row that declares the wrong permission is worse than a row that admits it
 * does not know. The two vocabularies stay apart on sight: every MCP scope
 * begins `mcp:`, no IAM permission does, and `surface` says which to expect.
 */
export const PERMISSION_UNSTATED = 'unstated';

/**
 * What a call written by the door ended as, when it was let through.
 *
 * The second value the `outcome` column was built for, and it is here for the
 * reason the column exists at all: *"allowed and no error" is not the whole
 * truth*. A guard runs before the handler and before every route-level guard
 * after it, so what it can honestly say is that the pause was removed and the
 * call went on — not that it succeeded, and not that nothing refused it
 * further down. The two agentic surfaces can say more, because they read a
 * result; this one cannot, and says so instead of implying it.
 *
 * It is beside `input_required`, not instead of it: those are the door's two
 * answers — *it stopped to ask* and *it went through* — and collapsing them is
 * the confusion decision 152 was written about.
 */
export const OUTCOME_DEPARTED = 'departed';
