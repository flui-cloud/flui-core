import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Which agentic surface a call came through, and how that travels one hop.
 *
 * The action cycle used to ask *what credential is this* — an `mcp:*` ceiling
 * meant "an agent", anything else meant "a person". That question is a proxy
 * for the one that actually matters, and it is a leaky one: the in-product
 * assistant runs the same tools, with write among them, on the person's own
 * browser session, which declares no ceiling at all. It was classified `user`
 * and met no gate.
 *
 * The question that matters is **who wrote the arguments of this call**. A form
 * on the dashboard and a `flui` command carry arguments a person typed; a tool
 * call carries arguments a language model chose. Pausing on the first would be
 * theatre — the person is confirming what they just asked for. Pausing on the
 * second is not, *even when the same person is watching*, because what is being
 * confirmed is not what they wrote.
 *
 * Both agentic surfaces already know which they are (`ToolSurface`). What was
 * missing is that the surface did not survive the hop: every tool reaches the
 * product by calling the API over loopback HTTP, and only the credential was
 * forwarded. This carries the surface across that hop.
 */
export type AgentSurface = 'mcp' | 'assistant';

const SURFACES = new Set<string>(['mcp', 'assistant']);

/** Where the surface rides. Lower-case: Node normalises inbound header names. */
export const AGENT_SURFACE_HEADER = 'x-flui-agent-surface';

/**
 * Minted once per process, never persisted, never leaves this process except on
 * a loopback socket back to it.
 *
 * A bare header would be assertable by any client, and while asserting one can
 * only ever *add* a pause — there is no route where being an agent grants
 * anything — it would also let a caller stamp `agent` on the attribution
 * columns of an operation it performed itself. That is a register built to
 * answer "did she do this, or did something acting for her" being handed a way
 * to lie to it. The token costs fifteen lines and removes the question.
 *
 * The self-call lands on this very process by construction (`McpApiClient`
 * resolves its own listener, not the published URL), so a token that does not
 * match means the loop is not closed on this instance — and then the surface is
 * dropped rather than trusted.
 */
const PROCESS_TOKEN = randomBytes(32).toString('hex');

/** The value the loopback client sends. */
export function agentSurfaceHeader(surface: AgentSurface): string {
  return `${surface}.${PROCESS_TOKEN}`;
}

function tokenMatches(candidate: string): boolean {
  if (candidate.length !== PROCESS_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(PROCESS_TOKEN));
}

/**
 * The surface a request declares, or `undefined` for everything else.
 *
 * Fail-closed on every question it can be asked: no header, an unknown surface
 * name, a wrong or missing token — all read as "no declaration", which is the
 * answer that changes nothing.
 */
export function agentSurfaceOf(
  headers: Record<string, unknown> | undefined,
): AgentSurface | undefined {
  const raw = headers?.[AGENT_SURFACE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const at = value.lastIndexOf('.');
  if (at <= 0) return undefined;
  const surface = value.slice(0, at);
  if (!SURFACES.has(surface)) return undefined;
  if (!tokenMatches(value.slice(at + 1))) return undefined;
  return surface as AgentSurface;
}

/**
 * The credential identity a standing concession hangs from when the assistant
 * is the agent and no API key authenticated the person.
 *
 * A concession is given to *an agent*, not to a person — "a different key, even
 * one the same person minted, starts from proposals again". The in-product
 * assistant has no key row, and without an identity it could only ever be told
 * "once": a copilot that asks the identical question every single turn, which
 * is worse than the state this replaces and is the failure decision 78 exists
 * to remember.
 *
 * There is exactly one assistant per person, so a fixed identity is accurate
 * rather than a convenience — and it is scoped by `ownerUserId` everywhere it
 * is read, so it names one person's assistant and never a shared one. It is
 * deliberately not UUID-shaped: `api_keys.id` is, and the two must never be
 * mistakable for each other.
 *
 * The same trick is NOT extended to the MCP surface. There, several distinct
 * agent identities can reach the product without a key row (project roles from
 * the identity provider), and one shared name would merge grants that were
 * given separately.
 */
export const ASSISTANT_AGENT_KEY_ID = 'surface:assistant';
