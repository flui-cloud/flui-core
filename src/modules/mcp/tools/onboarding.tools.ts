import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

interface AgentSkillPayload {
  version: string;
  digest: string;
  filename: string;
  mediaType: string;
  mcpEndpoint: string;
  content: string;
}

/**
 * How to operate this instance, reached from inside the session the agent
 * already has open — no second transport, no bearer header to attach by
 * hand, no URL to fetch on its own. Before this tool existed, the only way
 * to reach the same content was `GET /auth/agent-skill`, a plain HTTP call
 * outside MCP that a "paste this into your chat" instruction could describe
 * but not authenticate — the agent needed a bearer header nobody told it how
 * to attach. This tool and that route return the same document; this one
 * just answers on the channel already open.
 *
 * Its scope, `mcp:onboarding:read`, is the one exception in the whole
 * catalogue: nobody switches it on, because `ApiKeyService.generateApiKey`
 * unions it into every scoped key unconditionally (see that scope's own doc
 * comment in `mcp-scopes.ts`). So this is reachable the moment a credential
 * exists, regardless of which groups were picked at mint time — the same
 * "no permission asked" posture the REST route already has, carried onto
 * this transport rather than granted anew.
 */
export const ONBOARDING_TOOLS: ToolDef[] = [
  defineTool({
    name: 'get_started',
    routes: ['GET /auth/agent-skill', 'POST /auth/agent-skill/check-in'],
    description:
      "How to operate this Flui instance — call this first, before anything else. Returns the instructions that teach an agent how work is done here (deployment, secrets, the action-cycle pattern for anything that needs a person's say-so) and records that this credential has just read them, so whoever issued it can see the connection is alive.",
    scope: MCP_SCOPE.ONBOARDING_READ,
    inputSchema: {},
    run: async (_args, ctx) => {
      const skill = await ctx.api.get<AgentSkillPayload>('/auth/agent-skill');
      // Best-effort: a dropped check-in must never turn a working read into a
      // failed tool call. The agent already has what it asked for either way.
      await ctx.api
        .post('/auth/agent-skill/check-in', { skillVersion: skill.version })
        .catch(() => undefined);
      return skill;
    },
  }),
];
