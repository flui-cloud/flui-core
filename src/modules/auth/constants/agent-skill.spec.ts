import {
  AGENT_SKILL_FILENAME,
  AGENT_SKILL_VERSION,
  agentSkillDigest,
  renderAgentSkill,
  skillFreshness,
} from './agent-skill';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';
import { API_KEY_PREFIX } from '../utils/api-key-hash.util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Snake_case terms the document uses that are states of the protocol, not tools. */
const NOT_A_TOOL = new Set(['input_required']);

const FACTS = {
  mcpEndpoint: 'https://flui.example/api/v1/mcp',
  apiBaseUrl: 'https://flui.example/api/v1',
};

describe('the agent skill', () => {
  /**
   * The pin. It is not a tautology and it is not decoration: the digest is
   * taken over the document body, so any edit changes it, and the only way to
   * make this pass again is to look at what changed and decide whether the
   * version should move with it.
   *
   * The failure it exists to prevent has already happened here once — a
   * published knowledge base describing CLI 0.2.0 for months, because the thing
   * that should have regenerated it was broken and nothing said so. A skill
   * whose version silently stops matching its content produces the same
   * outcome, one step closer to something that acts on it.
   */
  it('pins the version to the content it describes', () => {
    expect({
      version: AGENT_SKILL_VERSION,
      digest: agentSkillDigest(),
    }).toEqual({ version: '1.3.0', digest: 'c6480ce7a6ae' });
  });

  /**
   * The tool reading is a different document, and the pin has to say so. One
   * digest covering both would leave "which of these is that agent holding?"
   * unanswerable, which is the only thing a digest is for.
   */
  it('pins the tool reading separately, because it is a different text', () => {
    expect(agentSkillDigest('tool')).not.toBe(agentSkillDigest('http'));
    expect(agentSkillDigest('tool')).toBe('cf19ca157e87');
  });

  it('is stable across renders — the digest identifies the instructions, not the installation', () => {
    const other = agentSkillDigest();
    renderAgentSkill({
      mcpEndpoint: 'https://b/api/v1/mcp',
      apiBaseUrl: 'https://b/api/v1',
    });
    expect(agentSkillDigest()).toBe(other);
  });

  describe('what it says about this instance', () => {
    const doc = renderAgentSkill(FACTS);

    it('points the agent at the endpoint it was given', () => {
      expect(doc).toContain('POST https://flui.example/api/v1/mcp');
      expect(doc).toContain(
        'POST https://flui.example/api/v1/auth/agent-skill/check-in',
      );
    });

    it('leaves no placeholder unsubstituted', () => {
      expect(doc).not.toMatch(/\{\{[A-Z_]+\}\}/);
    });

    it('tells the agent to declare the version it is actually holding', () => {
      expect(doc).toContain(`{"skillVersion": "${AGENT_SKILL_VERSION}"}`);
    });

    it('is a skill file an agent can save', () => {
      expect(AGENT_SKILL_FILENAME).toBe('SKILL.md');
      expect(doc.startsWith('---\nname: flui\n')).toBe(true);
    });
  });

  /**
   * The first instruction in the document, and the one that changes with the
   * reader: an agent that arrived through `get_started` holds no credential and
   * has no raw-HTTP tool, and the bridge has already checked in for it.
   */
  describe('the surface the reader is on', () => {
    const http = renderAgentSkill(FACTS);
    const tool = renderAgentSkill({ ...FACTS, surface: 'tool' });

    it('defaults to the text for somebody holding their own key', () => {
      expect(renderAgentSkill(FACTS)).toBe(
        renderAgentSkill({ ...FACTS, surface: 'http' }),
      );
      expect(http).toContain(
        'POST https://flui.example/api/v1/auth/agent-skill/check-in',
      );
    });

    it('never asks a keyless reader to make a call it cannot make', () => {
      expect(tool).not.toContain('/auth/agent-skill/check-in');
      expect(tool).not.toContain('Before anything else');
    });

    it('tells the keyless reader the check-in already happened', () => {
      expect(tool).toContain('already checked you in');
    });

    it('sends it to the tool that answers what the check-in would have', () => {
      expect(tool).toContain('my_permissions');
    });

    it('leaves no placeholder unsubstituted on either surface', () => {
      expect(tool).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(http).not.toMatch(/\{\{[A-Z_]+\}\}/);
    });

    it('changes only that section', () => {
      const tail = 'Your credential is a ceiling, never a grant';
      expect(http.slice(http.indexOf(tail))).toBe(
        tool.slice(tool.indexOf(tail)),
      );
    });
  });

  /**
   * The rule that cannot be left to memory: instructions travel, get committed
   * to repositories and pasted into issues. A credential inside one is a
   * credential published.
   *
   * The structural half is the signature — `renderAgentSkill` takes two URLs
   * and nothing else, so no key can reach the text through an argument. This is
   * the other half, asserted over the rendered result.
   */
  describe('never carries a credential', () => {
    it('contains no minted key and no secret-shaped token', () => {
      const doc = renderAgentSkill(FACTS);
      expect(doc).not.toContain(API_KEY_PREFIX);
      expect(doc).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      expect(doc).not.toMatch(/Bearer\s+\S{16,}/);
    });

    it('says where the key goes without ever holding one', () => {
      expect(renderAgentSkill(FACTS)).toContain(
        'Authorization: Bearer <the key you were given>',
      );
    });
  });

  /**
   * The other way a skill rots: the product renames something and the document
   * keeps confidently naming the old thing. Every tool the text names by hand
   * is checked against the live registry, so a rename upstream turns this red
   * instead of turning an agent wrong.
   */
  describe('names only tools that exist', () => {
    const named = [
      ...new Set(
        [...renderAgentSkill(FACTS).matchAll(/`([a-z][a-z0-9_]{3,})`/g)].map(
          (m) => m[1],
        ),
      ),
    ];

    it('mentions at least the anchors an agent needs by name', () => {
      expect(named).toEqual(
        expect.arrayContaining(['operation_status', 'app_variable_request']),
      );
    });

    it('names no tool the registry does not publish', () => {
      const tools = new Set(ALL_TOOLS.map((t) => t.name));
      const invented = named.filter(
        (word) =>
          word.includes('_') && !tools.has(word) && !NOT_A_TOOL.has(word),
      );
      expect(invented).toEqual([]);
    });

    /**
     * The one snake_case term in the document that is a protocol state rather
     * than a tool, pinned to where the product actually emits it — an exception
     * granted by hand is how a list like this stops meaning anything.
     */
    it('pins the one non-tool term to the code that emits it', () => {
      const source = readFileSync(
        join(__dirname, '..', '..', 'mcp', 'tools', 'variables.tools.ts'),
        'utf8',
      );
      expect([...NOT_A_TOOL]).toEqual(['input_required']);
      expect(source).toContain('input_required');
    });
  });

  describe('freshness', () => {
    it.each([
      [AGENT_SKILL_VERSION, 'current'],
      ['0.9.0', 'stale'],
      ['1.3.1', 'ahead'],
      ['whatever', 'unknown'],
      ['', 'undeclared'],
      [null, 'undeclared'],
      [undefined, 'undeclared'],
    ])('reads %s as %s', (declared, expected) => {
      expect(skillFreshness(declared as string | null)).toBe(expected);
    });

    /**
     * Kept apart from `stale` on purpose: an agent carrying a newer document is
     * talking to an instance nobody upgraded, and telling it to re-fetch would
     * hand it something older than what it already has.
     */
    it('does not call a newer agent out of date', () => {
      expect(skillFreshness('2.0.0')).toBe('ahead');
    });
  });
});
