import { createHash } from 'node:crypto';

/**
 * The instructions handed to a coding agent when somebody connects one, and the
 * version that says whether they still describe this instance.
 *
 * **The version is of the content, not of the format.** A format version
 * answers "can you parse this?", which nobody ever asks: the document is
 * Markdown, and every agent that reads one version reads all of them. The
 * question actually asked — the one the published knowledge base got wrong when
 * it described CLI 0.2.0 for months — is "do these instructions still describe
 * what is on the other end?", and that is a question about content. So the
 * version tracks the body below, `agentSkillDigest()` fingerprints it, and
 * `agent-skill.spec.ts` pins the pair. Editing a line without bumping the
 * version turns that suite red, which is the only mechanism here that a
 * forgetful author cannot walk past.
 *
 * Nothing in this file is per-credential. The template takes two facts about
 * the installation and nothing else — no key, no name, no scope list — so there
 * is no argument through which a secret could reach the text. That is the
 * "never a credential inside a skill" rule made structural rather than
 * remembered.
 */
export const AGENT_SKILL_VERSION = '1.0.0';

/** What the agent stores it as. Claude Code and its kin read `SKILL.md`. */
export const AGENT_SKILL_FILENAME = 'SKILL.md';

export const AGENT_SKILL_MEDIA_TYPE = 'text/markdown';

/** The two installation facts the text needs, and the only inputs it takes. */
export interface AgentSkillFacts {
  /** Absolute URL of the MCP endpoint, e.g. `https://api.example/api/v1/mcp`. */
  mcpEndpoint: string;
  /** Absolute URL the REST API is served under, e.g. `https://api.example/api/v1`. */
  apiBaseUrl: string;
}

/**
 * Every claim below is read off this repository rather than remembered:
 * the endpoint and prefix from `main.ts`, the two refusal wordings from
 * `mcp-tool.util.ts` and `mcp-api.client.ts`, the strict-argument behaviour and
 * the model projection from `mcp-agent-contract.spec.ts`, the polling sentence
 * from `outcomeNote`, the secret hand-off from `variables.tools.ts`, and the
 * destructive switch from `mcp-server.factory.ts`. The tool names named here
 * are pinned against `ALL_TOOLS` by the spec, so a rename upstream turns this
 * file red instead of turning an agent confidently wrong.
 */
const AGENT_SKILL_TEMPLATE = `---
name: flui
description: Operate a Flui instance through its MCP server — deploy and run applications, read logs and health, manage backups, migrations, mail, DNS, gateway routes and access. Use whenever the task concerns an application, cluster or environment hosted on Flui.
---

# Working with Flui

You are connected to one Flui installation. It speaks MCP over Streamable HTTP:

    POST {{MCP_ENDPOINT}}
    Authorization: Bearer <the key you were given>

The key was handed to you once, outside this file. **This file never contains
one**, and nothing here should ever be edited to hold one.

## Before anything else

Call \`POST {{API_BASE_URL}}/auth/agent-skill/check-in\` with
\`{"skillVersion": "{{VERSION}}"}\` and the same \`Authorization\` header.

It answers two things you cannot work out on your own: **what you are connected
to** — the endpoint, the credential's name, the scopes it carries, when it
expires — and **whether these instructions are still the current ones**. If it
answers \`stale\`, fetch \`GET {{API_BASE_URL}}/auth/agent-skill\` and follow
what comes back instead of this. Doing that costs one call per session and is
the only thing standing between you and being confidently out of date.

The same call is what tells the person who connected you that you exist. Until
you make it, their panel shows the key as never having spoken.

## Your credential is a ceiling, never a grant

\`tools/list\` returns only the tools your key's scopes carry, so the toolbox you
see is already narrowed. Holding a tool is still not permission to touch a
particular thing: what a call may reach is decided by Flui's own access control
on the route it lands on, exactly as it would be for a person clicking.

Two refusals mean opposite things and must not be treated alike:

- **"missing required scope"** — the tool was never handed to you. No resource
  makes this call work. Ask for the scope to be granted; do not retry.
- **"Refused by Flui access control (HTTP 403)"** — you hold the tool, but the
  person you act for is not allowed on that resource. Nothing you can change
  about the call changes the answer. Say which resource was refused and stop.

You act **as** the person who connected you. You never have standing of your own,
and you can never do something they could not.

## Arguments are strict

Every tool publishes \`additionalProperties: false\`. An argument name you
invented is **rejected**, never quietly ignored — and the error names both the
key you sent and the keys that are accepted, so read it and correct yourself
rather than guessing again.

## Results are projections, not the API

Most tools return a compact shape built for a model, not the full REST payload.
A field the HTTP API has may simply not be there. Ask for what you need through
a tool; do not infer that a field exists because it exists elsewhere.

## Long work does not finish when the call returns

Installing, deploying, uninstalling and scaling **enqueue** work and hand back an
\`operationId\`. Nothing polls it for you on this surface. Call
\`operation_status\` with that id — and with \`applicationId\` whenever the
operation belongs to an application, because that is the reading route a
non-administrator is allowed on — until \`done\` is true, then report the real
outcome. Never claim something finished before \`done\`, and on \`FAILED\` relay
the exact \`error\` rather than retrying.

## Secrets are not yours to hold

You must never hold, generate, guess or relay a secret. To get a sensitive value
set, call \`app_variable_request\` with the application and the key name — there
is no \`value\` argument and there will never be one. It records the key as
awaiting a value and hands back a command of the form
\`flui app env set <app> <KEY>\` for the person to run; the value goes from their
terminal straight to encrypted storage and is never shown to you.

That call returning \`input_required\` is a **state, not a failure**: park, tell
the person what to run, and do not retry it unchanged. Reading variables tells
you which keys are set and which are missing, never what any of them holds.

## Destructive tools may not be there at all

Tearing things down needs two independent yeses: your key must carry the
destructive scope, and the server must have destructive operations switched on.
If a delete tool is absent from \`tools/list\`, that is the answer — it is not a
temporary glitch and there is no argument that works around it.

## What is here

Ask \`tools/list\`; it is the only accurate answer, because it is filtered to
your key. Broadly, the toolbox covers: the catalogue and templates, manifest
validation, applications (install, deploy, start/stop/restart, scale, logs,
events, releases, traffic, alerts, removal), clusters and their resources,
DNS and gateway routes, repositories and GitHub connection, backups, database
and application migrations, scheduled jobs, mail delivery, and who has access
to what.

## Say when you are seeing less than everything

Lists come back filtered to what the person you act for may see. That filtering
is invisible in the result. If a conclusion depends on a list being complete —
"there are no other applications", "nothing else is running" — say that you can
only speak for what you were shown.
`;

const PLACEHOLDER = /\{\{(MCP_ENDPOINT|API_BASE_URL|VERSION)\}\}/g;

/**
 * The document for this installation.
 *
 * Substitution is by fixed name over a fixed template: there is no path by
 * which a caller-supplied string other than these two URLs enters the text.
 */
export function renderAgentSkill(facts: AgentSkillFacts): string {
  const values: Record<string, string> = {
    MCP_ENDPOINT: facts.mcpEndpoint,
    API_BASE_URL: facts.apiBaseUrl,
    VERSION: AGENT_SKILL_VERSION,
  };
  return AGENT_SKILL_TEMPLATE.replace(PLACEHOLDER, (_, key: string) =>
    key in values ? values[key] : '',
  );
}

/**
 * A fingerprint of the body, taken before substitution so it identifies the
 * instructions and not the installation. Two instances on the same version
 * therefore agree on the digest, which is what makes it usable as a pin.
 */
export function agentSkillDigest(): string {
  return createHash('sha256')
    .update(AGENT_SKILL_TEMPLATE, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

export type SkillFreshness =
  | 'current'
  | 'stale'
  | 'ahead'
  | 'unknown'
  | 'undeclared';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * How the version an agent says it holds compares with the one on this
 * instance.
 *
 * `ahead` and `unknown` are kept apart from `stale` because they call for
 * different behaviour and only one of them is the agent's problem: an agent
 * carrying a newer document is talking to an instance that has not been
 * upgraded, and one carrying an unparseable string was configured by hand.
 * Collapsing all three into "stale" would send an agent to re-fetch a document
 * older than the one it already has.
 */
export function skillFreshness(declared?: string | null): SkillFreshness {
  const value = declared?.trim();
  if (!value) return 'undeclared';
  if (value === AGENT_SKILL_VERSION) return 'current';
  const mine = SEMVER.exec(AGENT_SKILL_VERSION);
  const theirs = SEMVER.exec(value);
  if (!mine || !theirs) return 'unknown';
  for (let i = 1; i <= 3; i++) {
    const a = Number(theirs[i]);
    const b = Number(mine[i]);
    if (a !== b) return a < b ? 'stale' : 'ahead';
  }
  return 'current';
}
